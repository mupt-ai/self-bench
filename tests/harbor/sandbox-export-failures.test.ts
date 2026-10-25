import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../src/lib/process.js";
import { fakeRegistry } from "../support/fake-registry.js";
import { SANDBOX_SDKS } from "../support/sandbox-sdks.js";

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

for (const [label, damage, message] of [
  ["ends early", "archive = archive[:-20]", "the downloaded archive ended early"],
  [
    "continues past its end",
    "archive = archive + archive",
    "the downloaded archive continues past its end",
  ],
] as const) {
  test(`a downloaded archive that ${label} pushes no image`, async () => {
    const root = await temporary();
    const tokenFile = join(root, "registry-token");
    const registry = await fakeRegistry(tokenFile, servers);
    const tar = join(root, "rootfs.tar");
    await writeFile(tar, Buffer.alloc(70_000, 3));
    const runtime = fileURLToPath(new URL("../../src/harnesses/harbor/runtime/", import.meta.url));
    const result = await runCommand(
      "python3",
      [
        "-c",
        `${SANDBOX_SDKS}
${damage}
import asyncio
sys.path.insert(0, sys.argv[1])
from selfbench_sandbox_export import export_sandbox
try:
    asyncio.run(export_sandbox("e2b", "template", "task-1")); raise SystemExit("no error")
except RuntimeError as error:
    assert str(error) == ${JSON.stringify(message)}, error
assert events[-1] == "killed", events
print("ok")
`,
        runtime,
        tar,
      ],
      {
        env: {
          ...process.env,
          SELFBENCH_EXPORT_REGISTRY: registry.api,
          SELFBENCH_EXPORT_TOKEN_FILE: tokenFile,
          SELFBENCH_EXPORT_CONFIG: "{}",
        },
        timeoutMs: 30_000,
      },
    );
    expect(result.stdout.trim()).toBe("ok");
    expect(registry.manifests.size).toBe(0);
    expect(registry.blobs.size).toBe(0);
  });
}

test("an E2B download cut off by the sandbox's lifetime says so", async () => {
  const root = await temporary();
  const tokenFile = join(root, "registry-token");
  const registry = await fakeRegistry(tokenFile, servers);
  const tar = join(root, "rootfs.tar");
  await writeFile(tar, Buffer.alloc(70_000, 4));
  const runtime = fileURLToPath(new URL("../../src/harnesses/harbor/runtime/", import.meta.url));
  const result = await runCommand(
    "python3",
    [
      "-c",
      `${SANDBOX_SDKS}
import asyncio
sys.path.insert(0, sys.argv[1])
import selfbench_sandbox_export
selfbench_sandbox_export.E2B_LIFETIME_SECS = 0
original = E2BSandbox.__init__
def resetting(self):
    original(self)
    async def read(*args, **kwargs):
        raise ConnectionResetError("Connection reset by peer")
    self.files = types.SimpleNamespace(read=read)
E2BSandbox.__init__ = resetting
try:
    asyncio.run(selfbench_sandbox_export.export_sandbox("e2b", "template", "task-1"))
    raise SystemExit("no error")
except RuntimeError as error:
    assert "one-hour lifetime" in str(error) and isinstance(error.__cause__, ConnectionResetError), error
assert events[-1] == "killed", events
print("ok")
`,
      runtime,
      tar,
    ],
    {
      env: {
        ...process.env,
        SELFBENCH_EXPORT_REGISTRY: registry.api,
        SELFBENCH_EXPORT_TOKEN_FILE: tokenFile,
        SELFBENCH_EXPORT_CONFIG: "{}",
      },
      timeoutMs: 30_000,
    },
  );
  expect(result.stdout.trim()).toBe("ok");
  expect(registry.manifests.size).toBe(0);
});
