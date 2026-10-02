import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { runCommand } from "../../src/lib/process.js";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-export-script-"));
  roots.push(root);
  return root;
}

const sha256 = (data: Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

/** Registry stand-in for the export's pushes: chunked and monolithic blob uploads, manifests. */
async function fakeRegistry(): Promise<{
  api: string;
  blobs: Map<string, Buffer>;
  manifests: Map<string, Buffer>;
}> {
  const blobs = new Map<string, Buffer>();
  const manifests = new Map<string, Buffer>();
  const uploads = new Map<string, Buffer[]>();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(request.url ?? "/", "http://localhost");
    expect(request.headers.authorization).toBe(
      `Basic ${Buffer.from("oauth2accesstoken:push-token").toString("base64")}`,
    );
    if (request.method === "POST" && url.pathname.endsWith("/blobs/uploads/")) {
      const id = String(uploads.size);
      uploads.set(id, []);
      response.writeHead(202, { location: `/upload/${id}?state=x` }).end();
    } else if (request.method === "PATCH" && url.pathname.startsWith("/upload/")) {
      uploads.get(url.pathname.slice(8))?.push(body);
      response.writeHead(202, { location: `${url.pathname}?state=y` }).end();
    } else if (request.method === "PUT" && url.pathname.startsWith("/upload/")) {
      const data = Buffer.concat([...(uploads.get(url.pathname.slice(8)) ?? []), body]);
      expect(sha256(data)).toBe(url.searchParams.get("digest") ?? "");
      blobs.set(url.searchParams.get("digest") ?? "", data);
      response.writeHead(201).end();
    } else if (request.method === "PUT" && url.pathname.includes("/manifests/")) {
      expect(request.headers["content-type"]).toBe("application/vnd.oci.image.manifest.v1+json");
      manifests.set(url.pathname, body);
      response.writeHead(201).end();
    } else response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { api: `http://127.0.0.1:${port}/v2/selfbench-test/selfbench-tasks`, blobs, manifests };
}

test("the export streams the sandbox's root filesystem into one layer and pushes the image", async () => {
  const registry = await fakeRegistry();
  const root = await temporary();
  const tar = join(root, "rootfs.tar");
  await writeFile(tar, Buffer.alloc(70_000, 7));
  const result = await runCommand(
    "python3",
    [
      "-c",
      `import runpy, sys, types
modal = types.ModuleType("modal")
data = open(sys.argv[2], "rb").read()
class Stream:
    def __init__(self, chunks): self.chunks = chunks
    def __aiter__(self): return self.gen()
    async def gen(self):
        for chunk in self.chunks: yield chunk
class Process:
    def __init__(self): self.stdout = Stream([data[i:i + 30000] for i in range(0, len(data), 30000)])
    async def _wait(self): return 0
    wait = types.SimpleNamespace(aio=None)
class Sandbox:
    terminated = False
    @staticmethod
    async def _create(*args, app=None, image=None, timeout=None):
        assert args == ("sleep", "infinity") and image == ("image", "im-Agent1"), (args, image)
        return Sandbox()
    async def _exec(self, *args, text=True):
        assert args[0] == "tar" and "--one-file-system" in args and not text, args
        process = Process(); process.wait = types.SimpleNamespace(aio=process._wait); return process
    async def _terminate(self): Sandbox.terminated = True
    def __init__(self):
        self.exec = types.SimpleNamespace(aio=self._exec)
        self.terminate = types.SimpleNamespace(aio=self._terminate)
Sandbox.create = types.SimpleNamespace(aio=Sandbox._create)
async def lookup(name=None, create_if_missing=False): return "app"
modal.App = types.SimpleNamespace(lookup=types.SimpleNamespace(aio=lookup))
modal.Image = types.SimpleNamespace(from_id=lambda image: ("image", image))
modal.Sandbox = Sandbox
sys.modules["modal"] = modal
script = sys.argv[1]
sys.argv = [script, "im-Agent1", "task-1"]
runpy.run_path(script, run_name="__main__")
assert Sandbox.terminated
`,
      fileURLToPath(
        new URL("../../src/harnesses/harbor/runtime/selfbench_export.py", import.meta.url),
      ),
      tar,
    ],
    {
      env: {
        ...process.env,
        SELFBENCH_EXPORT_REGISTRY: registry.api,
        SELFBENCH_EXPORT_TOKEN: "push-token",
        SELFBENCH_EXPORT_CONFIG: JSON.stringify({
          Env: ["CI=1"],
          User: "agent",
          WorkingDir: "/app",
        }),
      },
    },
  );

  // Pushed by digest and untagged, so it can be deleted with its task.
  const digest = result.stdout.trim();
  const manifest = registry.manifests.get(
    `/v2/selfbench-test/selfbench-tasks/task-1/manifests/${digest}`,
  );
  expect(manifest).toBeDefined();
  expect(digest).toBe(sha256(manifest ?? Buffer.alloc(0)));
  const parsed = JSON.parse(String(manifest)) as {
    config: { digest: string; size: number };
    layers: { digest: string; size: number; mediaType: string }[];
  };
  const layer = registry.blobs.get(parsed.layers[0]?.digest ?? "");
  expect(parsed.layers[0]?.mediaType).toBe("application/vnd.oci.image.layer.v1.tar+gzip");
  expect(parsed.layers[0]?.size).toBe(layer?.length ?? -1);
  // The layer is exactly the sandbox's tar stream, gzipped; the config names its uncompressed digest.
  const original = await readFile(tar);
  expect(gunzipSync(layer ?? Buffer.alloc(0)).equals(original)).toBe(true);
  const config = JSON.parse(String(registry.blobs.get(parsed.config.digest))) as Record<
    string,
    unknown
  >;
  expect(config).toMatchObject({
    architecture: "amd64",
    os: "linux",
    config: { Env: ["CI=1"], User: "agent", WorkingDir: "/app" },
    rootfs: { type: "layers", diff_ids: [sha256(original)] },
  });
});
