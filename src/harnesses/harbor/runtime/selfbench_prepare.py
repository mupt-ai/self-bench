"""Builds a task's Harbor images once, before any of an evaluation's trials start.

    python selfbench_prepare.py <task dir> <modal|e2b>

Each image is built the way Harbor's environment builds it for a trial, so every trial finds it
instead of building it again (and parallel trials of one task never build it side by side):

- Modal: the image is built into the workspace's image cache, which the trial's identical image
  then hits: the task's prebuilt `docker_image` (a Harbor registry task), pulled as Harbor pulls
  it, or else its Dockerfile. A
  compose verifier runs Docker-in-Docker and is left to the trial, and so is an image in
  SelfBench's registry, which a trial pulls with its own grant (selfbench_modal.py).
  Registries throttle many pulls that start together (public.ecr.aws answers "toomanyrequests:
  Data limit exceeded"), and Modal reports every failed build alike, so a build is tried again,
  waiting longer each time, before the task's trials are left to build it themselves.
- E2B: the template Harbor names after the environment's content hash is built unless its last
  build is ready (selfbench_e2b.py), as the trial's environment checks it.

Prints one line per image: `<role> <built|exists|skipped> [image]`.
"""

from __future__ import annotations

import asyncio
import os
import random
import sys
import tempfile
from pathlib import Path

from harbor.models.task.task import Task
from harbor.models.trial.paths import TrialPaths

BUILD_WAITS_SECS = (30, 60, 120, 240)


def _images(task: Task):
    yield "agent", task.paths.environment_dir, task.config.environment
    verifier = task.config.verifier.environment
    if verifier is not None and (task.paths.tests_dir / "Dockerfile").exists():
        yield "verifier", task.paths.tests_dir, verifier


async def _modal(context: Path, docker_image: str | None) -> str:
    from modal import App, Image
    from modal.exception import ImageBuildError

    registry = os.environ.get("SELFBENCH_REGISTRY_HOST")
    if (context / "docker-compose.yaml").exists():
        return "skipped"
    if docker_image and registry and docker_image.startswith(f"{registry}/"):
        return "skipped"
    # Harbor's Modal environment builds in its default app.
    app = await App.lookup.aio(name="__harbor__", create_if_missing=True)

    def image():
        # As Harbor's Modal environment makes it (_ModalDirect.start), so the trial's matches.
        if not docker_image:
            return Image.from_dockerfile(context / "Dockerfile", context_dir=context)
        if ".dkr.ecr." in docker_image:
            return Image.from_aws_ecr(docker_image, secret=None)
        return Image.from_registry(docker_image, secret=None)

    waits = list(BUILD_WAITS_SECS)
    while True:
        built = image()
        try:
            await built.build.aio(app)
            return f"built {built.object_id}"
        except ImageBuildError:
            if not waits:
                raise
            # Jitter spreads the retries of the many builds that were throttled together.
            await asyncio.sleep(waits.pop(0) * random.uniform(0.75, 1.25))


async def _e2b(task: Task, context: Path, config, scratch: Path) -> str:
    from selfbench_e2b import SelfBenchE2BEnvironment

    environment = SelfBenchE2BEnvironment(
        environment_dir=context,
        environment_name=task.short_name,
        session_id="selfbench-prepare",
        trial_paths=TrialPaths(scratch),
        task_env_config=config,
    )
    if await environment._does_template_exist():
        return f"exists {environment._template_name}"
    await environment._create_template()
    return f"built {environment._template_name}"


async def main(path: str, backend: str) -> None:
    task = Task(Path(path))
    with tempfile.TemporaryDirectory() as scratch:

        async def prepare(role: str, context: Path, config) -> None:
            if backend == "modal":
                image = getattr(config, "docker_image", None)
                outcome = await _modal(context, image)
            elif backend == "e2b":
                outcome = await _e2b(task, context, config, Path(scratch) / role)
            else:
                outcome = "skipped"
            print(f"{role} {outcome}", flush=True)

        await asyncio.gather(*(prepare(*image) for image in _images(task)))


if __name__ == "__main__":
    asyncio.run(main(*sys.argv[1:]))
