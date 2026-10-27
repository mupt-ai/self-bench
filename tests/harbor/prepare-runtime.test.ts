import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../src/lib/process.js";

const PREPARE = fileURLToPath(
  new URL("../../src/harnesses/harbor/runtime/selfbench_prepare.py", import.meta.url),
);

test("Modal prepare pulls a task's prebuilt image as Harbor does, retrying throttled builds", async () => {
  const result = await runCommand(
    "python3",
    [
      "-I",
      "-c",
      `import asyncio, importlib.util, pathlib, sys, types
modal, exception = types.ModuleType("modal"), types.ModuleType("modal.exception")
class ImageBuildError(Exception): pass
exception.ImageBuildError = ImageBuildError
# How many more builds of each image registries refuse before one succeeds.
refusals, built, made = {}, [], []
class Image:
    def __init__(self, kind, source, secret="unset"):
        self.kind, self.source, self.object_id = kind, source, f"im-{kind}"
        made.append((kind, source, secret))
    @staticmethod
    def from_registry(image, secret): return Image("registry", image, secret)
    @staticmethod
    def from_aws_ecr(image, secret): return Image("ecr", image, secret)
    @staticmethod
    def from_dockerfile(path, context_dir): return Image("dockerfile", str(path))
    @property
    def build(self):
        async def aio(app):
            if refusals.get(self.source, 0):
                refusals[self.source] -= 1
                raise ImageBuildError(f"Image build for {self.object_id} failed.")
            built.append(self.source)
        return types.SimpleNamespace(aio=aio)
async def lookup(name, create_if_missing): return name
modal.Image, modal.App = Image, types.SimpleNamespace(lookup=types.SimpleNamespace(aio=lookup))
stubs = {"modal": modal, "modal.exception": exception}
for name in ["harbor", "harbor.models", "harbor.models.task", "harbor.models.task.task", "harbor.models.trial", "harbor.models.trial.paths"]:
    stubs[name] = types.ModuleType(name)
stubs["harbor.models.task.task"].Task = object
stubs["harbor.models.trial.paths"].TrialPaths = object
sys.modules.update(stubs)
spec = importlib.util.spec_from_file_location("selfbench_prepare", sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
waits = []
async def sleep(seconds): waits.append(seconds)
module.asyncio.sleep, module.random.uniform = sleep, lambda low, high: 1
public = "public.ecr.aws/team/task:v1"
async def check():
    context = pathlib.Path("/task/environment")
    # A throttled pull waits longer each time, then builds the image a trial would start from.
    refusals[public] = 2
    assert await module._modal(context, public) == "built im-registry"
    assert waits == [30, 60] and built == [public], (waits, built)
    assert made[-1] == ("registry", public, None), made
    private = "123.dkr.ecr.us-east-1.amazonaws.com/task:v1"
    assert await module._modal(context, private) == "built im-ecr"
    assert await module._modal(context, None) == "built im-dockerfile"
    assert built[-1] == "/task/environment/Dockerfile", built
    # An image in SelfBench's registry is left to the trial, which pulls it with its grant.
    module.os.environ["SELFBENCH_REGISTRY_HOST"] = "app.selfbench.test"
    assert await module._modal(context, "app.selfbench.test/task@sha256:abc") == "skipped"
    # A build refused every time fails once its waits run out; the trials then build it.
    refusals[public], waits[:] = 99, []
    try:
        await module._modal(context, public)
    except ImageBuildError:
        assert waits == list(module.BUILD_WAITS_SECS), waits
    else:
        raise AssertionError("a build refused every time must fail")
asyncio.run(check())
`,
      PREPARE,
    ],
    { env: { PATH: process.env.PATH ?? "" } },
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});
