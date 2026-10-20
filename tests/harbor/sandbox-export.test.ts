import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { runCommand } from "../../src/lib/process.js";
import { fakeRegistry } from "../support/fake-registry.js";

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

/** Stand-ins for the E2B, Daytona and Vercel SDKs: each serves `archive` as the packed rootfs. */
const SANDBOX_SDKS = `import gzip, sys, types
archive = gzip.compress(open(sys.argv[2], "rb").read())
events = []
def module(name, **attrs):
    mod = types.ModuleType(name); mod.__dict__.update(attrs); sys.modules[name] = mod; return mod
def check(command):
    assert "tar --one-file-system" in command and "gzip -1 > /tmp/selfbench-rootfs.tar.gz" in command, command
    events.append("packed")
class E2BSandbox:
    @staticmethod
    async def create(template=None, timeout=None, http_version=None):
        # HTTP/2 downloads end early on too_many_data_frames.
        assert http_version == "1.1", http_version
        events.append(("e2b", template)); return E2BSandbox()
    def __init__(self):
        async def run(cmd, user=None, timeout=None): assert user == "root"; check(cmd)
        async def read(path, format=None, user=None, request_timeout=None):
            async def chunks():
                for i in range(0, len(archive), 1000): yield archive[i:i + 1000]
            assert format == "stream"; return chunks()
        self.commands = types.SimpleNamespace(run=run); self.files = types.SimpleNamespace(read=read)
    async def kill(self): events.append("killed")
module("e2b", AsyncSandbox=E2BSandbox)
class DaytonaSandbox:
    def __init__(self):
        async def exec(command, timeout=None):
            check(command); return types.SimpleNamespace(exit_code=0, result="")
        async def download_file(remote, local, timeout=None): open(local, "wb").write(archive)
        self.process = types.SimpleNamespace(exec=exec); self.fs = types.SimpleNamespace(download_file=download_file)
    async def delete(self): events.append("killed")
class AsyncDaytona:
    async def create(self, params, timeout=None):
        events.append(("daytona", params.snapshot)); return DaytonaSandbox()
    async def close(self): events.append("closed")
def snapshot_params(snapshot, os_user=None, auto_stop_interval=None):
    # Packed as root, and never stopped while the archive downloads.
    assert os_user == "root" and auto_stop_interval == 0, (os_user, auto_stop_interval)
    return types.SimpleNamespace(snapshot=snapshot)
module("daytona", AsyncDaytona=AsyncDaytona, CreateSandboxFromSnapshotParams=snapshot_params)
class Reader:
    def __init__(self): self.offset = 0
    async def __aenter__(self): return self
    async def __aexit__(self, *exc): return False
    async def read(self, size):
        chunk = archive[self.offset:self.offset + size]; self.offset += len(chunk); return chunk
class VercelSandbox:
    def __init__(self): self.fs = types.SimpleNamespace(open=lambda path, mode: Reader())
    async def run_process(self, command, args, sudo=False, capture_output=False, kill_after=None):
        assert sudo; check(args[1]); return types.SimpleNamespace(returncode=0, stderr="")
    async def destroy(self): events.append("killed")
async def create_sandbox(image=None, project_id=None, execution_time_limit=None):
    events.append(("vercel", image)); assert project_id == "project"; return VercelSandbox()
async def resolve_vcr_scope(): return types.SimpleNamespace(project_id="project")
for name in ["harbor", "harbor.environments", "harbor.environments.vercel", "vercel"]: module(name)
module("harbor.environments.vercel.vcr", resolve_vcr_scope=resolve_vcr_scope)
module("vercel.sandbox", create_sandbox=create_sandbox)
module("modal", App=None, Image=None, Sandbox=None)
`;

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
    // The pushed layer is the sandbox's tar as packed, re-gzipped for the registry.
    expect(gunzipSync(layer ?? Buffer.alloc(0)).equals(await readFile(tar))).toBe(true);
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
