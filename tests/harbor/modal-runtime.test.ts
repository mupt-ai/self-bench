import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { AGENT_MINUTES, trialTimeouts } from "../../src/contracts/agent-limit.js";
import { runCommand } from "../../src/lib/process.js";

test("the Modal environment pulls a task's images with the run's grant and bounds sandbox lifetime", async () => {
  const result = await runCommand("python3", [
    "-I",
    "-c",
    `import asyncio, importlib.util, os, pathlib, sys, types
modal = types.ModuleType("modal")
class Image:
    def __init__(self, object_id): self.object_id = object_id
    @staticmethod
    def from_registry(image, secret):
        assert image == "registry.example/task@sha256:abc", image
        assert secret == {"REGISTRY_USERNAME": "selfbench", "REGISTRY_PASSWORD": "grant"}, secret
        return Image("im-Registry")
modal.Image = Image
modal.Secret = types.SimpleNamespace(from_dict=lambda values: values)
harbor_modal = types.ModuleType("harbor.environments.modal")
class ModalEnvironment:
    def __init__(self, environment_dir, compose=False, **kwargs):
        self.kwargs = kwargs
        self.environment_dir = pathlib.Path(environment_dir)
        self._compose_mode = compose
        self._image = Image("im-Built")
        self.task_env_config = types.SimpleNamespace(docker_image=None)
        self.started = []
    async def _create_sandbox(self, **kwargs):
        self.started.append(self._image.object_id)
        return "sandbox"
harbor_modal.ModalEnvironment = ModalEnvironment
sys.modules.update({"modal": modal, "harbor.environments.modal": harbor_modal})
sys.path.insert(0, str(pathlib.Path(sys.argv[1]).parent))
spec = importlib.util.spec_from_file_location("selfbench_modal", sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
async def check():
    built = module.SelfBenchModalEnvironment("/task/environment")
    await built._create_sandbox()
    assert built.started == ["im-Built"], built.started
    assert built.kwargs == {"sandbox_timeout_secs": 10800, "sandbox_idle_timeout_secs": 1800}, built.kwargs
    assert module.SANDBOX_LIFETIME_SECS * 1000 > ${trialTimeouts(AGENT_MINUTES.max).harborMs}
    os.environ.update(SELFBENCH_REGISTRY_HOST="registry.example", SELFBENCH_REGISTRY_USERNAME="selfbench", SELFBENCH_REGISTRY_PASSWORD="grant")
    pulled = module.SelfBenchModalEnvironment("/task/tests")
    pulled.task_env_config.docker_image = "registry.example/task@sha256:abc"
    await pulled._create_sandbox()
    assert pulled.started == ["im-Registry"], pulled.started
    # Compose runs Docker-in-Docker: the DinD host pulls, with the login staged there instead.
    composed = module.SelfBenchModalEnvironment("/task/tests", compose=True)
    composed.task_env_config.docker_image = "registry.example/task@sha256:abc"
    await composed._create_sandbox()
    assert composed.started == ["im-Built"], composed.started
    tuned = module.SelfBenchModalEnvironment("/task/tests", sandbox_idle_timeout_secs=None)
    assert tuned.kwargs["sandbox_idle_timeout_secs"] is None, tuned.kwargs
asyncio.run(check())
`,
    fileURLToPath(
      new URL("../../src/harnesses/harbor/runtime/selfbench_modal.py", import.meta.url),
    ),
  ]);
  expect(result.exitCode).toBe(0);
});
