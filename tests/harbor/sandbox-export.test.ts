import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { runCommand } from "../../src/lib/process.js";
import { fakeRegistry, sha256 } from "../support/fake-registry.js";
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

for (const [provider, image] of [
  ["e2b", "selfbench-task-1__abc"],
  ["daytona", "harbor__abc__snapshot"],
  ["vercel", "vcr.vercel.com/team/project/harbor:abc"],
] as const) {
  test(`a ${provider} export packs the verified sandbox's filesystem and pushes it as one layer`, async () => {
    const root = await temporary();
    const tokenFile = join(root, "registry-token");
    const registry = await fakeRegistry(tokenFile, servers);
    const tar = join(root, "rootfs.tar");
    await writeFile(tar, Buffer.alloc(70_000, 9));
    const runtime = fileURLToPath(new URL("../../src/harnesses/harbor/runtime/", import.meta.url));
    const result = await runCommand(
      "python3",
      [
        "-c",
        `${SANDBOX_SDKS}
import runpy
sys.path.insert(0, sys.argv[1])
sys.argv = [sys.argv[1] + "/selfbench_export.py", ${JSON.stringify(provider)}, ${JSON.stringify(image)}, "task-1"]
runpy.run_path(sys.argv[0], run_name="__main__")
assert events[0] == (${JSON.stringify(provider)}, ${JSON.stringify(image)}), events
assert "packed" in events and "killed" in events, events
`,
        runtime,
        tar,
      ],
      {
        env: {
          ...process.env,
          SELFBENCH_EXPORT_REGISTRY: registry.api,
          SELFBENCH_EXPORT_TOKEN_FILE: tokenFile,
          SELFBENCH_EXPORT_CONFIG: JSON.stringify({ Env: ["CI=1"] }),
        },
      },
    );
    const digest = result.stdout.trim();
    const manifest = registry.manifests.get(
      `/v2/selfbench-test/selfbench-tasks/task-1/manifests/${digest}`,
    );
    const parsed = JSON.parse(String(manifest)) as { layers: { digest: string }[] };
    const layer = registry.blobs.get(parsed.layers[0]?.digest ?? "");
    // The pushed layer is the sandbox's own gzip, byte for byte, and its diff_id hashes the tar.
    expect(layer?.equals(await readFile(`${tar}.gz`))).toBe(true);
    expect(gunzipSync(layer ?? Buffer.alloc(0)).equals(await readFile(tar))).toBe(true);
    const config = registry.blobs.get(
      (JSON.parse(String(manifest)) as { config: { digest: string } }).config.digest,
    );
    expect(JSON.parse(String(config)).rootfs.diff_ids).toEqual([sha256(await readFile(tar))]);
  });
}

test("the pack script tolerates tar's changed-file status and fails on any other", async () => {
  const root = await temporary();
  const runtime = fileURLToPath(new URL("../../src/harnesses/harbor/runtime/", import.meta.url));
  const script = `
import os, subprocess, sys, types
sys.modules["modal"] = types.SimpleNamespace(App=None, Image=None, Sandbox=None)
sys.path.insert(0, sys.argv[1])
from selfbench_sandbox_export import PACK
bin_dir = sys.argv[2]
def status(tar_code, gzip_code):
    for name, code in [("tar", tar_code), ("gzip", gzip_code)]:
        path = os.path.join(bin_dir, name)
        open(path, "w").write(f"#!/bin/sh\\ncat >/dev/null 2>&1 <&0 & exit {code}\\n")
        os.chmod(path, 0o755)
    env = {**os.environ, "PATH": bin_dir + ":/bin:/usr/bin"}
    return subprocess.run(["bash", "-c", PACK], env=env, capture_output=True).returncode
# Tar's 1 (a file changed while read) is fine; every other failure, tar's or gzip's, is not.
print([status(0, 0), status(1, 0), status(2, 0), status(0, 1)])
`;
  const result = await runCommand("python3", ["-I", "-c", script, runtime, root]);
  expect(result.stdout.trim()).toBe("[0, 0, 1, 1]");
});

test("the pack script archives the CA certificates even when they are a mount point", async () => {
  const root = await temporary();
  const runtime = fileURLToPath(new URL("../../src/harnesses/harbor/runtime/", import.meta.url));
  // E2B mounts its certificates over /etc/ssl/certs, which --one-file-system alone leaves out;
  // tar archives a mount point's contents when it is named as an operand.
  const script = `
import os, subprocess, sys, types
sys.modules["modal"] = types.SimpleNamespace(App=None, Image=None, Sandbox=None)
sys.path.insert(0, sys.argv[1])
from selfbench_sandbox_export import PACK
bin_dir, args = sys.argv[2], os.path.join(sys.argv[2], "args")
for name, body in [("tar", f'printf "%s\\\\n" "$@" > {args}'), ("gzip", "cat >/dev/null")]:
    path = os.path.join(bin_dir, name)
    open(path, "w").write(f"#!/bin/sh\\n{body}\\n")
    os.chmod(path, 0o755)
env = {**os.environ, "PATH": bin_dir + ":/bin:/usr/bin"}
code = subprocess.run(["bash", "-c", PACK.replace("/tmp/selfbench-rootfs.tar.gz", os.path.join(bin_dir, "out"))], env=env).returncode
operands = open(args).read().split()
print(code, operands[-2:] if os.path.isdir("/etc/ssl/certs") else operands[-1:])
`;
  const result = await runCommand("python3", ["-I", "-c", script, runtime, root]);
  const expected = existsSync("/etc/ssl/certs") ? "0 ['.', './etc/ssl/certs']" : "0 ['.']";
  expect(result.stdout.trim()).toBe(expected);
});

test("a failed pack still removes the sandbox and ends the export instead of hanging", async () => {
  const root = await temporary();
  const tokenFile = join(root, "registry-token");
  const registry = await fakeRegistry(tokenFile, servers);
  const tar = join(root, "rootfs.tar");
  await writeFile(tar, Buffer.alloc(10, 1));
  const runtime = fileURLToPath(new URL("../../src/harnesses/harbor/runtime/", import.meta.url));
  const result = await runCommand(
    "python3",
    [
      "-c",
      `${SANDBOX_SDKS}
import asyncio
async def fail(self, *args, **kwargs): raise RuntimeError("disk full")
sys.path.insert(0, sys.argv[1])
from selfbench_sandbox_export import export_sandbox
original = E2BSandbox.__init__
def broken(self):
    original(self); self.commands = types.SimpleNamespace(run=lambda *a, **k: fail(self))
E2BSandbox.__init__ = broken
try:
    asyncio.run(export_sandbox("e2b", "template", "task-1")); raise SystemExit("no error")
except RuntimeError as error:
    assert str(error) == "disk full", error
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
  // The upload opens with the first bytes, so a pack that fails (or runs long) holds no request.
  expect(registry.uploads.size).toBe(0);
});
