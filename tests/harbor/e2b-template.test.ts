import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../src/lib/process.js";

const ENVIRONMENT = fileURLToPath(
  new URL("../../src/harnesses/harbor/runtime/selfbench_e2b.py", import.meta.url),
);
/** Empty stand-ins for the modules selfbench_e2b.py imports; each test fills in what it uses. */
const STUBS = `import sys, types
for name in ["e2b", "httpx", "harbor", "harbor.environments", "harbor.environments.e2b"]:
    sys.modules[name] = types.ModuleType(name)
e2b, harbor_e2b = sys.modules["e2b"], sys.modules["harbor.environments.e2b"]
sys.modules["harbor"].environments = sys.modules["harbor.environments"]
sys.modules["harbor.environments"].e2b = harbor_e2b
for name in ["AsyncSandbox", "AsyncTemplate", "BuildException", "BuildInfo", "Template", "TemplateBuildStatus"]:
    setattr(e2b, name, object)
class SandboxException(Exception):
    def __init__(self, message, status_code=None):
        super().__init__(message); self.status_code = status_code
e2b.SandboxException = SandboxException
def load():
    import importlib.util
    spec = importlib.util.spec_from_file_location("selfbench_e2b", sys.argv[1])
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
`;

test("the E2B environment builds a template unless its default build is ready", async () => {
  const result = await runCommand("python3", [
    "-c",
    `${STUBS}import asyncio, enum, logging
from dataclasses import dataclass, field
class TemplateBuildStatus(str, enum.Enum):
    BUILDING = "building"; WAITING = "waiting"; READY = "ready"; ERROR = "error"
class BuildException(Exception): pass
@dataclass
class BuildInfo:
    template_id: str; build_id: str; name: str; alias: str; tags: list = field(default_factory=list)
# What E2B holds per template name: its default build's id and that build's status.
templates = {
    "ready": ("b1", TemplateBuildStatus.READY),
    "failed": ("b2", TemplateBuildStatus.ERROR),
    "building": ("b3", TemplateBuildStatus.BUILDING),
    "waiting": ("b4", TemplateBuildStatus.WAITING),
    "missing-build": ("b5", None),
    "unrelated-error": ("b6", None),
    "untagged": (None, None),
}
class AsyncTemplate:
    @staticmethod
    async def alias_exists(name): return name in templates
    @staticmethod
    async def get_tags(name):
        build = templates[name][0]
        return [types.SimpleNamespace(tag="default", build_id=build)] if build else []
    @staticmethod
    async def get_build_status(info):
        build, status = templates[info.template_id]
        assert info.build_id == build, info
        if info.template_id == "missing-build": raise BuildException(f"400: Build '{build}' not found")
        if info.template_id == "unrelated-error": raise BuildException("401: Unauthorized")
        return types.SimpleNamespace(status=status)
e2b.AsyncTemplate, e2b.BuildException, e2b.BuildInfo, e2b.TemplateBuildStatus = AsyncTemplate, BuildException, BuildInfo, TemplateBuildStatus
class E2BEnvironment:
    def __init__(self, name):
        self._template_name = name
        self.logger = logging.getLogger("test")
    async def _does_template_exist(self): return await AsyncTemplate.alias_exists(self._template_name)
harbor_e2b.E2BEnvironment = E2BEnvironment
module = load()
async def check():
    found = {name: await module.SelfBenchE2BEnvironment(name)._does_template_exist() for name in ["ready", "failed", "building", "waiting", "missing-build", "untagged", "missing"]}
    # An exact missing build is rebuilt, while other E2B failures still surface.
    assert found == {"ready": True, "failed": False, "building": False, "waiting": False, "missing-build": False, "untagged": False, "missing": False}, found
    try:
        await module.SelfBenchE2BEnvironment("unrelated-error")._does_template_exist()
    except BuildException as error:
        assert str(error) == "401: Unauthorized", error
    else:
        raise AssertionError("unrelated E2B errors must propagate")
asyncio.run(check())
`,
    ENVIRONMENT,
  ]);
  expect(result.exitCode).toBe(0);
});

test("the E2B environment makes a SelfBench task image's template with the run's pull grant", async () => {
  const result = await runCommand(
    "python3",
    [
      "-c",
      `${STUBS}import asyncio, logging
builds = []
class Builder:
    def __init__(self, *steps): self.steps = steps
    def run_cmd(self, command, user=None): return Builder(*self.steps, ("run", command, user))
    def set_user(self, user): return Builder(*self.steps, ("user", user))
    def set_workdir(self, workdir): return Builder(*self.steps, ("workdir", workdir))
    def __eq__(self, other): return isinstance(other, Builder) and self.steps == other.steps
    def __repr__(self): return repr(self.steps)
class Template:
    def from_image(self, image, username=None, password=None):
        return Builder(("image", image, username, password))
class AsyncTemplate:
    @staticmethod
    async def build(template, alias, **resources): builds.append((template, alias, resources))
e2b.AsyncTemplate, e2b.Template = AsyncTemplate, Template
class E2BEnvironment:
    def __init__(self, image, cpus=None):
        self.task_env_config = types.SimpleNamespace(docker_image=image)
        self._template_name = "task__hash"
        self._effective_cpus, self._effective_memory_mb = cpus, 8192
        self.logger = logging.getLogger("test")
    async def _create_template(self): builds.append("dockerfile")
harbor_e2b.E2BEnvironment = E2BEnvironment
module = load()
image = "app.selfbench.test/task@sha256:" + "a" * 64
async def image_config(pulled, username, password):
    assert (pulled, username, password) == (image, "selfbench", "grant")
    return {"Env": ["PATH=/usr/local/cargo/bin:/usr/bin", "CI=1"], "User": "agent", "WorkingDir": "/app"}
module.image_config = image_config
async def check():
    await module.SelfBenchE2BEnvironment(image, cpus=4)._create_template()
    # E2B drops an image's config, so the template carries its ENV, USER and WORKDIR itself.
    profile = "printf %s 'export PATH=/usr/local/cargo/bin:/usr/bin\\nexport CI=1\\n' > /etc/profile.d/selfbench-image-env.sh"
    expected = Builder(("image", image, "selfbench", "grant"), ("run", profile, "root"), ("user", "agent"), ("workdir", "/app"))
    assert builds == [(expected, "task__hash", {"cpu_count": 4, "memory_mb": 8192})], builds
    builds.clear()
    # Any other image, or a task without one, is Harbor's own build.
    await module.SelfBenchE2BEnvironment("docker.io/library/python:3")._create_template()
    await module.SelfBenchE2BEnvironment(None)._create_template()
    assert builds == ["dockerfile", "dockerfile"], builds
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

test("E2B sandboxes live as long as the longest Harbor run, or the plan's limit", async () => {
  const result = await runCommand("python3", [
    "-c",
    `${STUBS}import asyncio
plan = {"hours": 24, "error": None}
calls = []
class AsyncSandbox:
    @classmethod
    async def create(cls, **options):
        calls.append(options)
        if plan["error"]: raise SandboxException(*plan["error"])
        if options["timeout"] > plan["hours"] * 3600:
            # E2B's answer, as a Hobby key gives it, to a lifetime beyond the plan.
            raise SandboxException(f"400: Timeout cannot be greater than {plan['hours']} hours", 400)
        return cls()
e2b.AsyncSandbox = harbor_e2b.AsyncSandbox = AsyncSandbox
# Harbor's own E2BEnvironment._create_sandbox, through its module's AsyncSandbox.
harbor_e2b.E2BEnvironment = type("E2BEnvironment", (), {})
async def harbor_create():
    return await harbor_e2b.AsyncSandbox.create(template="task__hash", timeout=86_400, network="allowlist")
module = load()
async def start(hours, error=None):
    plan.update(hours=hours, error=error); calls.clear()
    sandbox = await harbor_create()
    return isinstance(sandbox, AsyncSandbox), [call["timeout"] for call in calls]
async def check():
    # Three hours outlasts every Harbor run; Harbor's own 24 kept an orphaned sandbox for a day.
    assert await start(24) == (True, [3 * 3600]), calls
    # Harbor's other arguments reach E2B unchanged.
    assert calls == [{"template": "task__hash", "timeout": 3 * 3600, "network": "allowlist"}], calls
    try:
        await start(24, ("429: Rate limit exceeded", 429))
    except SandboxException as error:
        assert str(error) == "429: Rate limit exceeded", error
    else:
        raise AssertionError("other E2B errors must propagate")
    # A Hobby key refuses anything over an hour, so the sandbox gets the hour it allows...
    assert await start(1) == (True, [3 * 3600, 3600]), calls
    # ...and the process's next sandbox asks for that hour straight away.
    assert await start(1) == (True, [3600]), calls
asyncio.run(check())
`,
    ENVIRONMENT,
  ]);
  expect(result.exitCode).toBe(0);
});
