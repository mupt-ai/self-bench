import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { LocalArtifactStore } from "../../src/artifacts/local.js";
import type { AuthoredTask } from "../../src/contracts/index.js";
import {
  dockerfileImageConfig,
  exportTaskImages,
} from "../../src/generation/pipeline/task-image-export.js";
import { runCommand } from "../../src/lib/process.js";

const REPOSITORY = "us-central1-docker.pkg.dev/selfbench-test/selfbench-tasks";
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-task-image-export-"));
  roots.push(root);
  return root;
}

const sha256 = (data: Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

test("an image keeps its base's config, then each ENV, USER and WORKDIR in order", async () => {
  const dockerfile = [
    `FROM python:3.13@sha256:${"a".repeat(64)}`,
    "USER root",
    'ENV CARGO_HOME="/usr/local/cargo" CI=1',
    // Docker substitutes both spellings of a variable.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a Dockerfile's ${PATH}, not a template
    'ENV PATH="$CARGO_HOME/bin:${PATH}"',
    "ENV LEGACY form with spaces",
    "RUN echo \\",
    "    ENV NOT_AN_INSTRUCTION=1",
    "ENV HOME=/home/agent",
    "USER agent",
    "WORKDIR /app",
  ].join("\n");
  const config = await dockerfileImageConfig(dockerfile, async (image) => {
    expect(image).toBe(`python:3.13@sha256:${"a".repeat(64)}`);
    return { Env: ["PATH=/usr/local/bin:/usr/bin", "PYTHON_VERSION=3.13.13"], WorkingDir: "/" };
  });
  expect(config).toEqual({
    Env: [
      "PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin",
      "PYTHON_VERSION=3.13.13",
      "CARGO_HOME=/usr/local/cargo",
      "CI=1",
      "LEGACY=form with spaces",
      "HOME=/home/agent",
    ],
    User: "agent",
    WorkingDir: "/app",
  });
});

test("an accepted task's Modal images are exported beside its pins", async () => {
  const root = await temporary();
  const store = new LocalArtifactStore(join(root, "store"));
  const source = join(root, "source", "harbor-task");
  for (const [context, user] of [
    ["environment", "agent"],
    ["tests", "root"],
  ] as const) {
    await mkdir(join(source, context), { recursive: true });
    await writeFile(
      join(source, context, "Dockerfile"),
      `FROM base@sha256:${"a".repeat(64)}\nENV ROLE=${context}\nUSER ${user}\nWORKDIR /app\n`,
    );
  }
  const archive = join(root, "task.tar.gz");
  await runCommand("tar", ["-czf", archive, "-C", join(root, "source"), "harbor-task"]);
  const bundle = await store.putFile("compile/harbor-task.tar.gz", archive, "application/gzip");
  const task: AuthoredTask = {
    candidateId: "cand-1",
    taskId: "Task_1",
    definition: bundle,
    sourceBundle: bundle,
    bundle,
    images: { provider: "modal", agent: "im-Agent1", verifier: "im-Verifier1" },
  };
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "harbor"), "#!/usr/bin/python3\n");
  await chmod(join(bin, "harbor"), 0o700);

  const exported = await exportTaskImages(store, task, {
    repository: REPOSITORY,
    env: { PATH: bin, MODAL_TOKEN_ID: "modal" },
    token: async () => "push-token",
    signal: new AbortController().signal,
    configFor: async () => ({ Env: ["PATH=/usr/bin"] }),
    command: (async (
      _command: string,
      args: readonly string[],
      options?: { env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ args, env: options?.env ?? {} });
      const digit = args[1] === "im-Agent1" ? "1" : "2";
      return { exitCode: 0, stdout: `pushing\nsha256:${digit.repeat(64)}\n`, stderr: "" };
    }) as typeof runCommand,
  });

  expect(exported.images).toEqual({
    provider: "modal",
    agent: "im-Agent1",
    verifier: "im-Verifier1",
    registry: {
      agent: `${REPOSITORY}/task-1@sha256:${"1".repeat(64)}`,
      verifier: `${REPOSITORY}/task-1@sha256:${"2".repeat(64)}`,
    },
  });
  expect(calls.map((call) => call.args.slice(1, 3))).toEqual([
    ["im-Agent1", "task-1"],
    ["im-Verifier1", "task-1"],
  ]);
  for (const [index, call] of calls.entries()) {
    expect(call.args[0]?.endsWith("selfbench_export.py")).toBe(true);
    expect(call.env.MODAL_TOKEN_ID).toBe("modal");
    expect(call.env.SELFBENCH_EXPORT_TOKEN).toBe("push-token");
    expect(call.env.SELFBENCH_EXPORT_REGISTRY).toBe(
      "https://us-central1-docker.pkg.dev/v2/selfbench-test/selfbench-tasks",
    );
    const role = index === 0 ? ["environment", "agent"] : ["tests", "root"];
    expect(JSON.parse(call.env.SELFBENCH_EXPORT_CONFIG ?? "")).toEqual({
      Env: ["PATH=/usr/bin", `ROLE=${role[0]}`],
      User: role[1],
      WorkingDir: "/app",
    });
  }
  // A task already exported, or never pinned, is left as it is.
  expect(await exportTaskImages(store, exported, {} as never)).toBe(exported);
});

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
