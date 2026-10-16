import { fileURLToPath } from "node:url";

export const ENVIRONMENT = fileURLToPath(
  new URL("../../src/harnesses/harbor/runtime/selfbench_e2b.py", import.meta.url),
);
/** Empty stand-ins for the modules selfbench_e2b.py imports; each test fills in what it uses. */
export const STUBS = `import sys, types
for name in ["e2b", "httpx", "dockerfile_parse", "harbor", "harbor.environments", "harbor.environments.e2b"]:
    sys.modules[name] = types.ModuleType(name)
sys.modules["dockerfile_parse"].DockerfileParser = object
e2b, harbor_e2b = sys.modules["e2b"], sys.modules["harbor.environments.e2b"]
sys.modules["harbor"].environments = sys.modules["harbor.environments"]
sys.modules["harbor.environments"].e2b = harbor_e2b
for name in ["AsyncSandbox", "AsyncTemplate", "BuildException", "BuildInfo", "Template", "TemplateBuildStatus"]:
    setattr(e2b, name, object)
class SandboxException(Exception):
    def __init__(self, message, status_code=None):
        super().__init__(message); self.status_code = status_code
class RateLimitException(SandboxException):
    def __init__(self, message): super().__init__(message, 429)
e2b.SandboxException, e2b.RateLimitException = SandboxException, RateLimitException
def load():
    import importlib.util, pathlib
    sys.path.insert(0, str(pathlib.Path(sys.argv[1]).parent))
    spec = importlib.util.spec_from_file_location("selfbench_e2b", sys.argv[1])
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module
`;

/** A Template stand-in that records each step, and an AsyncTemplate.build that keeps them. */
export const BUILDER = `builds = []
class Builder:
    def __init__(self, *steps): self.steps = steps
    def run_cmd(self, command, user=None): return Builder(*self.steps, ("run", command, user))
    def set_user(self, user): return Builder(*self.steps, ("user", user))
    def set_workdir(self, workdir): return Builder(*self.steps, ("workdir", workdir))
    def __eq__(self, other): return isinstance(other, Builder) and self.steps == other.steps
    def __repr__(self): return repr(self.steps)
class Template:
    def __init__(self, file_context_path=None): self.context = file_context_path
    def from_image(self, image, username=None, password=None):
        return Builder(("image", image, username, password))
    def from_dockerfile(self, dockerfile_content_or_path):
        return Builder(("dockerfile", self.context, dockerfile_content_or_path))
class AsyncTemplate:
    @staticmethod
    async def build(template, alias, **resources): builds.append((template, alias, resources))
e2b.AsyncTemplate, e2b.Template = AsyncTemplate, Template
class E2BEnvironment:
    def __init__(self, image=None, cpus=None):
        self.task_env_config = types.SimpleNamespace(docker_image=image)
        self.environment_dir = pathlib.Path("/task/tests")
        self._environment_definition_path = self.environment_dir / "Dockerfile"
        self._template_name = "task__hash"
        self._effective_cpus, self._effective_memory_mb = cpus, 8192
        self.logger = logging.getLogger("test")
harbor_e2b.E2BEnvironment = E2BEnvironment
`;
