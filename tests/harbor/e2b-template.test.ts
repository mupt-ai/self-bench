import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../src/lib/process.js";

test("the E2B environment builds a template unless its default build is ready", async () => {
  const result = await runCommand("python3", [
    "-c",
    `import asyncio, enum, importlib.util, logging, sys, types
from dataclasses import dataclass, field
e2b = types.ModuleType("e2b")
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
        # E2B finds an unfinished build only by template id, not by name.
        if status == TemplateBuildStatus.WAITING: raise BuildException(f"400: Build '{build}' not found")
        return types.SimpleNamespace(status=status)
e2b.AsyncTemplate, e2b.BuildException, e2b.BuildInfo, e2b.TemplateBuildStatus = AsyncTemplate, BuildException, BuildInfo, TemplateBuildStatus
harbor_e2b = types.ModuleType("harbor.environments.e2b")
class E2BEnvironment:
    def __init__(self, name):
        self._template_name = name
        self.logger = logging.getLogger("test")
    async def _does_template_exist(self): return await AsyncTemplate.alias_exists(self._template_name)
harbor_e2b.E2BEnvironment = E2BEnvironment
sys.modules.update({"e2b": e2b, "harbor.environments.e2b": harbor_e2b})
spec = importlib.util.spec_from_file_location("selfbench_e2b", sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
async def check():
    found = {name: await module.SelfBenchE2BEnvironment(name)._does_template_exist() for name in [*templates, "missing"]}
    # A name whose last build failed or is unfinished has no sandbox to start, so it is built again.
    assert found == {"ready": True, "failed": False, "building": False, "waiting": False, "untagged": False, "missing": False}, found
asyncio.run(check())
`,
    fileURLToPath(new URL("../../src/harnesses/harbor/runtime/selfbench_e2b.py", import.meta.url)),
  ]);
  expect(result.exitCode).toBe(0);
});
