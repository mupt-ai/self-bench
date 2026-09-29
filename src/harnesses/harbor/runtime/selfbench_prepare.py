"""Builds a task's Harbor images once, before any of an evaluation's trials start.

    python selfbench_prepare.py <task dir> <modal|e2b> [agent_image=im-…] [verifier_image=im-…]

Each image is built the way Harbor's environment builds it for a trial, so every trial finds it
instead of building it again (and parallel trials of one task never build it side by side):

- Modal: a pinned image the workspace can still use is kept; otherwise the Dockerfile image is
  built into the workspace's image cache, which the trial's identical Dockerfile then hits. A
  compose verifier runs Docker-in-Docker and is left to the trial.
- E2B: the template Harbor names after the environment's content hash is built unless it exists.

Prints one line per image: `<role> <pinned|built|exists|skipped> [image]`.
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

from harbor.models.task.task import Task
from harbor.models.trial.paths import TrialPaths


def _images(task: Task):
    yield "agent", task.paths.environment_dir, task.config.environment
    verifier = task.config.verifier.environment
    if verifier is not None and (task.paths.tests_dir / "Dockerfile").exists():
        yield "verifier", task.paths.tests_dir, verifier


async def _modal(context: Path, pin: str | None) -> str:
    from modal import App, Image
    from selfbench_modal import UNUSABLE_PIN

    if (context / "docker-compose.yaml").exists():
        return "skipped"
    # Harbor's Modal environment builds in its default app.
    app = await App.lookup.aio(name="__harbor__", create_if_missing=True)
    if pin:
        try:
            await Image.from_id(pin).build.aio(app)  # only looks the image up
            return f"pinned {pin}"
        except UNUSABLE_PIN:
            pass
    image = Image.from_dockerfile(context / "Dockerfile", context_dir=context)
    await image.build.aio(app)
    return f"built {image.object_id}"


async def _e2b(task: Task, context: Path, config, scratch: Path) -> str:
    from harbor.environments.e2b import E2BEnvironment

    environment = E2BEnvironment(
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


async def main(path: str, backend: str, *pins: str) -> None:
    task = Task(Path(path))
    pinned = dict(pin.split("=", 1) for pin in pins)
    with tempfile.TemporaryDirectory() as scratch:

        async def prepare(role: str, context: Path, config) -> None:
            if backend == "modal":
                outcome = await _modal(context, pinned.get(f"{role}_image"))
            elif backend == "e2b":
                outcome = await _e2b(task, context, config, Path(scratch) / role)
            else:
                outcome = "skipped"
            print(f"{role} {outcome}", flush=True)

        await asyncio.gather(*(prepare(*image) for image in _images(task)))


if __name__ == "__main__":
    asyncio.run(main(*sys.argv[1:]))
