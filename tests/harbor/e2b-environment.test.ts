import { expect, test } from "bun:test";
import { runCommand } from "../../src/lib/process.js";
import { BUILDER, ENVIRONMENT, STUBS } from "../support/e2b-runtime.js";

test("every E2B template carries the environment its image or Dockerfile gives a container", async () => {
  const result = await runCommand(
    "python3",
    [
      "-c",
      `${STUBS}import asyncio, logging, pathlib, shlex
${BUILDER}module = load()
registry = "app.selfbench.test/task@sha256:" + "a" * 64
public = "public.ecr.aws/team/task:v1"
configs = {
    registry: {"Env": ["PATH=/usr/local/cargo/bin:/usr/bin", "CI=1"], "User": "agent", "WorkingDir": "/app"},
    public: {"Env": ["PATH=/opt/venv/bin:/usr/bin", "VIRTUAL_ENV=/opt/venv"], "WorkingDir": "/app"},
}
async def image_config(image, grant=None):
    # Only SelfBench's registry gets the run's pull grant; E2B pulls any other image anonymously.
    assert grant == (("selfbench", "grant") if image == registry else None), (image, grant)
    return configs[image]
async def dockerfile_env(path):
    assert path == "/task/tests/Dockerfile", path
    return {"PATH": "/root/go/bin:/usr/bin", "GOFLAGS": "-mod=mod"}
module.image_config, module.dockerfile_env = image_config, dockerfile_env
def profile(env):
    return ("run", f"printf %s {shlex.quote(module.profile_script(env))} > /etc/profile.d/selfbench-image-env.sh", "root")
async def check():
    await module.SelfBenchE2BEnvironment(registry, cpus=4)._create_template()
    await module.SelfBenchE2BEnvironment(public)._create_template()
    await module.SelfBenchE2BEnvironment(None)._create_template()
    # E2B drops an image's config and a Dockerfile's ENV, so the template carries them itself.
    assert builds == [
        (Builder(("image", registry, "selfbench", "grant"), profile({"PATH": "/usr/local/cargo/bin:/usr/bin", "CI": "1"}), ("user", "agent"), ("workdir", "/app")), "task__hash__env", {"cpu_count": 4, "memory_mb": 8192}),
        (Builder(("image", public, None, None), profile({"PATH": "/opt/venv/bin:/usr/bin", "VIRTUAL_ENV": "/opt/venv"}), ("workdir", "/app")), "task__hash__env", {"memory_mb": 8192}),
        (Builder(("dockerfile", "/task/tests", "/task/tests/Dockerfile"), profile({"PATH": "/root/go/bin:/usr/bin", "GOFLAGS": "-mod=mod"})), "task__hash__env", {"memory_mb": 8192}),
    ], builds
asyncio.run(check())
`,
      ENVIRONMENT,
    ],
    {
      env: {
        ...process.env,
        SELFBENCH_REGISTRY_HOST: "app.selfbench.test",
        SELFBENCH_REGISTRY_USERNAME: "selfbench",
        SELFBENCH_REGISTRY_PASSWORD: "grant",
      },
    },
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

test("the image's environment yields to what the sandbox or command sets, except PATH", async () => {
  const script = await runCommand("python3", [
    "-c",
    `${STUBS}harbor_e2b.E2BEnvironment = object
module = load()
print(module.profile_script({"PATH": "/opt/venv/bin:/usr/bin", "PYTHONPATH": "/app", "GREETING": "it's a \\"test\\" $HOME"}), end="")`,
    ENVIRONMENT,
  ]);
  expect(script.stderr).toBe("");
  // A login shell has already reset PATH; a variable set for the sandbox or command is kept.
  const shell = await runCommand(
    "bash",
    ["-c", `${script.stdout}printf '%s|%s|%s' "$PATH" "$PYTHONPATH" "$GREETING"`],
    { env: { PATH: "/usr/bin:/bin", PYTHONPATH: "/from-harbor" } },
  );
  expect(shell.stdout).toBe(`/opt/venv/bin:/usr/bin|/from-harbor|it's a "test" $HOME`);
});

test("a Dockerfile's container environment is its base image's ENV followed by its own", async () => {
  const result = await runCommand("python3", [
    "-c",
    `${STUBS}import asyncio
parsed = []
class DockerfileParser:
    def __init__(self, path, env_replace=True, parent_env=None):
        parsed.append((path, parent_env))
        self.baseimage = bases[path]
        self.structure = [{"instruction": "FROM"}] * (2 if path == "/multi/Dockerfile" else 1)
        # dockerfile_parse expands the Dockerfile's own ENV against the inherited values.
        self.envs = {"PATH": "/opt/venv/bin:" + (parent_env or {}).get("PATH", ""), "VIRTUAL_ENV": "/opt/venv"}
sys.modules["dockerfile_parse"].DockerfileParser = DockerfileParser
harbor_e2b.E2BEnvironment = object
module = load()
bases = {"/task/Dockerfile": "python:3.12", "/scratch/Dockerfile": "scratch", "/multi/Dockerfile": "runtime"}
async def image_config(image, grant=None):
    assert (image, grant) == ("python:3.12", None), (image, grant)
    return {"Env": ["PATH=/usr/local/bin:/usr/bin", "LANG=C.UTF-8"]}
module.image_config = image_config
async def check():
    env = await module.dockerfile_env("/task/Dockerfile")
    assert env == {"PATH": "/opt/venv/bin:/usr/local/bin:/usr/bin", "LANG": "C.UTF-8", "VIRTUAL_ENV": "/opt/venv"}, env
    assert parsed[-1] == ("/task/Dockerfile", {"PATH": "/usr/local/bin:/usr/bin", "LANG": "C.UTF-8"}), parsed
    # An image from scratch inherits nothing.
    assert await module.dockerfile_env("/scratch/Dockerfile") == {"PATH": "/opt/venv/bin:", "VIRTUAL_ENV": "/opt/venv"}
    # Like E2B's Dockerfile parser, multi-stage builds fail before a stage alias is read as an image.
    try:
        await module.dockerfile_env("/multi/Dockerfile")
    except ValueError as error:
        assert str(error) == "Multi-stage Dockerfiles are not supported", error
    else:
        raise AssertionError("multi-stage Dockerfiles must be rejected")
asyncio.run(check())
`,
    ENVIRONMENT,
  ]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

test("an image's config is read with the run's grant or the registry's anonymous token", async () => {
  const result = await runCommand("python3", [
    "-c",
    `${STUBS}import asyncio
harbor_e2b.E2BEnvironment = object
module = load()
# Docker Hub's defaults, a registry host with a port, and a tag next to a digest.
assert module.image_parts("python:3.12") == ("registry-1.docker.io", "library/python", "3.12")
assert module.image_parts("docker.io/org/tool") == ("registry-1.docker.io", "org/tool", "latest")
assert module.image_parts("localhost:5000/team/task:v1") == ("localhost:5000", "team/task", "v1")
assert module.image_parts("public.ecr.aws/team/task:v1@sha256:abc") == ("public.ecr.aws", "team/task", "sha256:abc")
requests = []
class Response:
    def __init__(self, status, body=None, headers=None):
        self.status_code, self.body, self.headers = status, body, headers or {}
    def raise_for_status(self):
        if self.status_code >= 400: raise RuntimeError(self.status_code)
        return self
    def json(self): return self.body
challenge = 'Bearer realm="https://public.ecr.aws/token/",service="public.ecr.aws",scope="aws"'
class AsyncClient:
    def __init__(self, base_url="", **options): self.base_url = base_url
    async def __aenter__(self): return self
    async def __aexit__(self, *exc): pass
    async def get(self, path, headers=None, auth=None, params=None):
        url = self.base_url + path
        requests.append((url, (headers or {}).get("authorization"), auth, params))
        if url == "https://public.ecr.aws/token/": return Response(200, {"token": "anonymous"})
        if (headers or {}).get("authorization") != "Bearer anonymous": return Response(401, headers={"www-authenticate": challenge})
        if url.endswith("/manifests/v1"):
            return Response(200, {"manifests": [{"platform": {"os": "linux", "architecture": "arm64"}, "digest": "arm"}, {"platform": {"os": "linux", "architecture": "amd64"}, "digest": "amd"}]})
        if url.endswith("/manifests/amd"): return Response(200, {"config": {"digest": "cfg"}})
        if url.endswith("/blobs/cfg"): return Response(200, {"config": {"Env": ["PATH=/opt/venv/bin"]}})
        raise AssertionError(url)
sys.modules["httpx"].AsyncClient, sys.modules["httpx"].Response = AsyncClient, Response
async def check():
    assert await module.image_config("public.ecr.aws/team/task:v1") == {"Env": ["PATH=/opt/venv/bin"]}
    base = "https://public.ecr.aws/v2/team/task"
    # The challenge's scope and service ask for the token; it then reads the amd64 config.
    assert requests == [
        (base + "/manifests/v1", None, None, None),
        ("https://public.ecr.aws/token/", None, None, {"scope": "aws", "service": "public.ecr.aws"}),
        (base + "/manifests/v1", "Bearer anonymous", None, None),
        (base + "/manifests/amd", "Bearer anonymous", None, None),
        (base + "/blobs/cfg", "Bearer anonymous", None, None),
    ], requests
asyncio.run(check())
`,
    ENVIRONMENT,
  ]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

test("a command whose E2B stream drops is waited on again, never run twice", async () => {
  const result = await runCommand("python3", [
    "-c",
    `${STUBS}import asyncio, logging, pathlib
for name in ["e2b.exceptions", "e2b.sandbox", "e2b.sandbox.commands", "e2b.sandbox.commands.command_handle", "harbor.environments.base"]:
    sys.modules[name] = types.ModuleType(name)
class TimeoutException(Exception): pass
class CommandExitException(Exception):
    def __init__(self, stdout, stderr, exit_code): self.stdout, self.stderr, self.exit_code = stdout, stderr, exit_code
class ExecResult:
    def __init__(self, stdout, stderr, return_code): self.stdout, self.stderr, self.return_code = stdout, stderr, return_code
sys.modules["e2b.exceptions"].TimeoutException = TimeoutException
sys.modules["e2b.sandbox.commands.command_handle"].CommandExitException = CommandExitException
sys.modules["harbor.environments.base"].ExecResult = ExecResult
class ConnectError(Exception): pass
class Handle:
    def __init__(self, pid, outcome, out=""): self.pid, self.outcome, self._stdout_chunks, self._stderr_chunks = pid, outcome, [out], []
    async def wait(self):
        if isinstance(self.outcome, Exception): raise self.outcome
        return self.outcome
class Commands:
    def __init__(self, sandbox): self.sandbox = sandbox
    async def connect(self, pid, timeout):
        self.sandbox.connects.append((pid, timeout))
        step = self.sandbox.reconnects.pop(0)
        if isinstance(step, Exception): raise step
        return step
class Files:
    def __init__(self, sandbox): self.sandbox = sandbox
    async def exists(self, path): return path in self.sandbox.files_written
    async def read(self, path): return self.sandbox.files_written[path]
class Sandbox:
    def __init__(self, reconnects, exit_after_drop=None):
        self.reconnects, self.connects, self.files_written = reconnects, [], {}
        self.exit_after_drop = exit_after_drop
        self.commands, self.files = Commands(self), Files(self)
harbor_e2b.effective_exec_cwd = lambda cwd, workdir, default: cwd or default
class E2BEnvironment:
    def __init__(self): self._template_name = "t"; self.logger = logging.getLogger("test")
    def _resolve_user(self, user): return user
    def _merge_env(self, env): return env
harbor_e2b.E2BEnvironment = E2BEnvironment
module = load()
module.RECONNECT_WAIT_SECS = 0
# Each drop and failed reconnect is logged; the assertions below cover them.
logging.getLogger("test").disabled = True
async def run(sandbox, first):
    env = module.SelfBenchE2BEnvironment.__new__(module.SelfBenchE2BEnvironment)
    env.task_env_config, env._workdir, env._sandbox, env.logger = types.SimpleNamespace(workdir=None), "/app", sandbox, logging.getLogger("test")
    dispatched = []
    async def dispatch(command, **options):
        dispatched.append(command)
        if sandbox.exit_after_drop is not None:
            sandbox.files_written[command.split("> ")[1].split("'")[0]] = sandbox.exit_after_drop
        return first
    env._dispatch_command = dispatch
    return dispatched, await env.exec("agent run", timeout_sec=600)
async def check():
    drop = ConnectError("Error reading content: peer closed connection without sending TLS close_notify")
    # The stream drops mid-run; the reconnected stream carries the rest and the exit code.
    sandbox = Sandbox([Handle(7, CommandExitException("rest", "", 3))])
    dispatched, result = await run(sandbox, Handle(7, drop, "start "))
    assert len(dispatched) == 1 and dispatched[0].endswith("EXIT\\nagent run"), dispatched
    assert (result.stdout, result.return_code) == ("start rest", 3), vars(result)
    assert sandbox.connects[0][0] == 7 and 0 < sandbox.connects[0][1] <= 600, sandbox.connects
    # The command ended while no stream was open: its trap's file gives the exit code.
    sandbox = Sandbox([], exit_after_drop="0")
    dispatched, result = await run(sandbox, Handle(8, drop, "out"))
    assert (result.stdout, result.return_code, sandbox.connects) == ("out", 0, []), vars(result)
    # A process that never comes back fails with the drop, after bounded reconnects.
    sandbox = Sandbox([ConnectError("not found")] * module.RECONNECTS)
    try:
        await run(sandbox, Handle(9, drop))
        raise AssertionError("expected the drop")
    except ConnectError as error:
        assert error is drop and len(sandbox.connects) == module.RECONNECTS
    # A time limit is the command's own outcome, not a dropped stream.
    try:
        await run(Sandbox([]), Handle(10, TimeoutException("limit")))
        raise AssertionError("expected the timeout")
    except TimeoutException: pass
asyncio.run(check())
`,
    ENVIRONMENT,
  ]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});
