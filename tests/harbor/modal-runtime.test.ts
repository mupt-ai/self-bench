import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_MINUTES, trialTimeouts } from "../../src/contracts/agent-limit.js";
import { runCommand } from "../../src/lib/process.js";

test("the Modal environment starts from its role's pin, falls back when Modal lost it, records the image, and bounds sandbox lifetime", async () => {
  const record = await mkdtemp(join(tmpdir(), "selfbench-modal-runtime-"));
  try {
    const result = await runCommand("python3", [
      "-I",
      "-c",
      `import asyncio, importlib.util, logging, os, pathlib, sys, types
modal = types.ModuleType("modal"); exception = types.ModuleType("modal.exception")
class NotFoundError(Exception): pass
class PermissionDeniedError(Exception): pass
class InvalidError(Exception): pass
class Image:
    def __init__(self, object_id): self.object_id = object_id
    @staticmethod
    def from_id(image_id): return Image(image_id)
    @staticmethod
    def from_registry(image, secret):
        assert image == "registry.example/task@sha256:abc", image
        assert secret == {"REGISTRY_USERNAME": "selfbench", "REGISTRY_PASSWORD": "grant"}, secret
        return Image("im-Registry")
modal.Image = Image
modal.Secret = types.SimpleNamespace(from_dict=lambda values: values)
exception.NotFoundError, exception.PermissionDeniedError, exception.InvalidError = NotFoundError, PermissionDeniedError, InvalidError
harbor_modal = types.ModuleType("harbor.environments.modal")
class ModalEnvironment:
    def __init__(self, environment_dir, compose=False, **kwargs):
        self.kwargs = kwargs
        self.environment_dir = pathlib.Path(environment_dir)
        self._compose_mode = compose
        self._image = Image("im-Built")
        self.task_env_config = types.SimpleNamespace(docker_image=None)
        self.logger = logging.getLogger("test")
        self.started = []
    async def _create_sandbox(self, **kwargs):
        if self._image.object_id == "im-Gone": raise NotFoundError()
        self.started.append(self._image.object_id)
        return "sandbox"
harbor_modal.ModalEnvironment = ModalEnvironment
sys.modules.update({"modal": modal, "modal.exception": exception, "harbor.environments.modal": harbor_modal})
sys.path.insert(0, str(pathlib.Path(sys.argv[1]).parent))
spec = importlib.util.spec_from_file_location("selfbench_modal", sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
record = pathlib.Path(sys.argv[2])
pins = dict(agent_image="im-Agent1", verifier_image="im-Gone", image_record_dir=str(record))
async def check():
    agent = module.SelfBenchModalEnvironment("/task/environment", **pins)
    await agent._create_sandbox()
    assert agent.started == ["im-Agent1"], agent.started
    verifier = module.SelfBenchModalEnvironment("/task/tests", **pins)
    await verifier._create_sandbox()
    assert verifier.started == ["im-Built"], verifier.started
    assert (record / "agent").read_text() == "im-Agent1"
    assert (record / "verifier").read_text() == "im-Built"
    composed = module.SelfBenchModalEnvironment("/task/tests", compose=True, verifier_image="im-Verifier1")
    await composed._create_sandbox()
    assert composed.started == ["im-Built"], composed.started
    for environment in (agent, verifier, composed):
        assert environment.kwargs == {"sandbox_timeout_secs": 10800, "sandbox_idle_timeout_secs": 1800}, environment.kwargs
    assert module.SANDBOX_LIFETIME_SECS * 1000 > ${trialTimeouts(AGENT_MINUTES.max).harborMs}
    os.environ.update(SELFBENCH_REGISTRY_HOST="registry.example", SELFBENCH_REGISTRY_USERNAME="selfbench", SELFBENCH_REGISTRY_PASSWORD="grant")
    fallback = module.SelfBenchModalEnvironment("/task/tests", verifier_image="im-Gone")
    fallback.task_env_config.docker_image = "registry.example/task@sha256:abc"
    await fallback._create_sandbox()
    assert fallback.started == ["im-Registry"], fallback.started
    preferred = module.SelfBenchModalEnvironment("/task/environment", agent_image="im-Agent1")
    preferred.task_env_config.docker_image = "registry.example/task@sha256:abc"
    await preferred._create_sandbox()
    assert preferred.started == ["im-Agent1"], preferred.started
    tuned = module.SelfBenchModalEnvironment("/task/tests", sandbox_idle_timeout_secs=None)
    assert tuned.kwargs["sandbox_idle_timeout_secs"] is None, tuned.kwargs
asyncio.run(check())
`,
      fileURLToPath(
        new URL("../../src/harnesses/harbor/runtime/selfbench_modal.py", import.meta.url),
      ),
      record,
    ]);
    expect(result.exitCode).toBe(0);
  } finally {
    await rm(record, { recursive: true, force: true });
  }
});
