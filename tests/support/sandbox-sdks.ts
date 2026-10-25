/** Stand-ins for the E2B, Daytona and Vercel SDKs: each serves `archive` as the packed rootfs. */
export const SANDBOX_SDKS = `import gzip, sys, types
archive = gzip.compress(open(sys.argv[2], "rb").read(), compresslevel=1)
open(sys.argv[2] + ".gz", "wb").write(archive)
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
