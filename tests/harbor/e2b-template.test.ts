import { expect, test } from "bun:test";
import { runCommand } from "../../src/lib/process.js";
import { BUILDER, ENVIRONMENT, STUBS } from "../support/e2b-runtime.js";

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
# What E2B holds per template name: its default build's id and that build's status. Every
# template's name carries the suffix that keeps templates built without the image's ENV unused.
templates = {f"{name}__env": value for name, value in {
    "ready": ("b1", TemplateBuildStatus.READY),
    "failed": ("b2", TemplateBuildStatus.ERROR),
    "building": ("b3", TemplateBuildStatus.BUILDING),
    "waiting": ("b4", TemplateBuildStatus.WAITING),
    "missing-build": ("b5", None),
    "unrelated-error": ("b6", None),
    "untagged": (None, None),
}.items()}
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
        if info.template_id == "missing-build__env": raise BuildException(f"400: Build '{build}' not found")
        if info.template_id == "unrelated-error__env": raise BuildException("401: Unauthorized")
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

test("an E2B plan too small for Harbor's 24-hour sandboxes is named as the cause", async () => {
  const result = await runCommand("python3", [
    "-c",
    `${STUBS}import asyncio
plan = {"hours": 24, "error": None, "status": 400}
calls = []
class AsyncSandbox:
    @classmethod
    async def create(cls, **options):
        calls.append(options)
        if plan["error"]: raise SandboxException(*plan["error"])
        if options["timeout"] > plan["hours"] * 3600:
            # E2B's answer, as a Hobby key gives it, to a lifetime beyond the plan.
            raise SandboxException(f"400: Timeout cannot be greater than {plan['hours']} hours", plan["status"])
        return cls()
e2b.AsyncSandbox = harbor_e2b.AsyncSandbox = AsyncSandbox
harbor_e2b.E2BEnvironment = type("E2BEnvironment", (), {})
module = load()
async def start(hours, status=400, error=None):
    plan.update(hours=hours, status=status, error=error); calls.clear()
    # Harbor's own E2BEnvironment._create_sandbox, through its module's AsyncSandbox.
    return await harbor_e2b.AsyncSandbox.create(template="task__hash", timeout=86_400, network="allowlist")
async def refusal(*args):
    try:
        await start(*args)
    except SandboxException as error:
        return str(error)
    raise AssertionError("the sandbox must not start")
async def check():
    # A plan that allows a day gets exactly what Harbor asked for.
    assert isinstance(await start(24), AsyncSandbox)
    assert calls == [{"template": "task__hash", "timeout": 86_400, "network": "allowlist"}], calls
    # A Hobby key is told its plan is the cause, with or without the status older e2b leaves off.
    for status in [400, None]:
        message = await refusal(1, status)
        assert message.startswith("This E2B key's plan allows sandboxes of at most 1 hour,"), message
        assert "such as Pro" in message and calls == [calls[0]] and calls[0]["timeout"] == 86_400, calls
    # Any other E2B error is E2B's own.
    assert await refusal(24, 400, ("429: Rate limit exceeded", 429)) == "429: Rate limit exceeded"
asyncio.run(check())
`,
    ENVIRONMENT,
  ]);
  expect(result.exitCode).toBe(0);
});

test("an E2B plan's memory cap is named when it refuses a task's template", async () => {
  const result = await runCommand("python3", [
    "-c",
    `${STUBS}import asyncio, logging, pathlib
class BuildException(Exception): pass
e2b.BuildException = BuildException
# E2B's answer, as a Pro key gives it, to a template asking for more memory than the plan allows.
capped = "400: Memory can't be higher than 8192 MiB (if you need to increase this limit, please contact support)"
setup = "failed to run command 'cd /app && /opt/selfbench-environment/setup.sh': exit status 2"
${BUILDER}def refuse(error):
    async def build(template, alias, **resources): raise BuildException(error)
    AsyncTemplate.build = build
module = load()
async def dockerfile_env(path): return {}
module.dockerfile_env = dockerfile_env
async def refusal(error):
    refuse(error)
    environment = module.SelfBenchE2BEnvironment()
    environment._effective_memory_mb = 12288
    try:
        await environment._create_template()
    except BuildException as refused:
        return refused
    raise AssertionError("the template must not build")
async def check():
    refused = await refusal(capped)
    assert str(refused).startswith("This E2B key's plan allows sandboxes of at most 8 GiB of memory, and this task asks for 12 GiB."), refused
    assert "support@e2b.dev" in str(refused) and str(refused.__cause__) == capped, refused
    # Any other failed build is E2B's own.
    assert str(await refusal(setup)) == setup
asyncio.run(check())
`,
    ENVIRONMENT,
  ]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});

test("the E2B environment waits for a free slot when E2B is at its concurrency limit", async () => {
  const result = await runCommand("python3", [
    "-c",
    `${STUBS}import asyncio, logging, pathlib
# E2B's answer once the team runs its plan's concurrent builds; a third request finds a slot.
full = "429: Rate limit exceeded, please try again later. - you have reached the maximum number of concurrent template builds (20)."
refusals = {"sandbox": 2, "template": 2}
calls, warnings = [], []
async def answer(what):
    calls.append(what)
    if what == "sandbox" and refusals.get("other"): raise SandboxException("500: Internal error", 500)
    if refusals[what]:
        refusals[what] -= 1
        raise RateLimitException(full)
${BUILDER}async def build(template, alias, **resources): await answer("template")
AsyncTemplate.build = build
async def create_sandbox(self): await answer("sandbox")
E2BEnvironment._create_sandbox = create_sandbox
module = load()
async def dockerfile_env(path): return {}
module.dockerfile_env = dockerfile_env
waits = []
async def sleep(seconds): waits.append(seconds)
module.asyncio.sleep = sleep
module.random.uniform = lambda low, high: 1
async def check():
    environment = module.SelfBenchE2BEnvironment()
    environment.logger = types.SimpleNamespace(warning=warnings.append)
    await environment._create_template()
    await environment._create_sandbox()
    # Each refused request waits, twice as long as the last, then asks again until E2B accepts.
    assert calls == ["template"] * 3 + ["sandbox"] * 3, calls
    assert waits == [15, 30, 15, 30], waits
    assert warnings[0] == f"E2B refused the template build task__hash__env ({full}); asking again in 15s", warnings
    # Any other E2B error fails at once, as before.
    refusals["other"] = 1; calls.clear(); waits.clear()
    try:
        await environment._create_sandbox()
    except SandboxException as error:
        assert str(error) == "500: Internal error" and calls == ["sandbox"] and waits == [], (error, calls, waits)
    else:
        raise AssertionError("other E2B errors must propagate")
asyncio.run(check())
`,
    ENVIRONMENT,
  ]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});
