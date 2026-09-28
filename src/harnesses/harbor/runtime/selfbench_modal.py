"""Harbor's Modal environment, started from a task's pinned image when it has one.

A task's verification builds its agent image (from ``environment/``) and its verifier image
(from ``tests/``) on Modal; the worker records the image each sandbox started from and keeps the
IDs with the accepted task. A trial passes them back as ``agent_image`` / ``verifier_image``
environment kwargs and starts from ``Image.from_id``, so it neither resolves nor builds the
Dockerfile. A pin Modal no longer knows (another workspace, or an image Modal dropped) falls
back to the Dockerfile build Harbor would have done. Compose tasks (Harbor's Docker-in-Docker
strategy) never pin: their sandbox image is the DinD host, not the task.
"""

from __future__ import annotations

from pathlib import Path

from modal import Image
from modal.exception import InvalidError, NotFoundError, PermissionDeniedError

from harbor.environments.modal import ModalEnvironment

# What Modal raises for an image ID this workspace cannot use; anything else is a real failure.
_UNUSABLE_PIN = (NotFoundError, PermissionDeniedError, InvalidError)

# Harbor builds the agent from the task's environment/ and a separate verifier from its tests/.
_ROLES = {"environment": "agent", "tests": "verifier"}


class SelfBenchModalEnvironment(ModalEnvironment):
    def __init__(
        self,
        *args,
        agent_image: str | None = None,
        verifier_image: str | None = None,
        image_record_dir: str | None = None,
        **kwargs,
    ):
        super().__init__(*args, **kwargs)
        self._selfbench_role = _ROLES.get(self.environment_dir.name)
        pins = {"agent": agent_image, "verifier": verifier_image}
        self._selfbench_pin = pins.get(self._selfbench_role) if self._selfbench_role else None
        self._selfbench_record = Path(image_record_dir) if image_record_dir else None

    async def _create_sandbox(self, **kwargs):
        if self._compose_mode or self._selfbench_role is None:
            return await super()._create_sandbox(**kwargs)
        if self._selfbench_pin:
            built = self._image
            self._image = Image.from_id(self._selfbench_pin)
            try:
                sandbox = await super()._create_sandbox(**kwargs)
            except _UNUSABLE_PIN:
                self.logger.warning(
                    f"Pinned image {self._selfbench_pin} is unavailable; building the Dockerfile"
                )
                self._image = built
                sandbox = await super()._create_sandbox(**kwargs)
            else:
                self.logger.info(f"Started {self._selfbench_role} from pinned image {self._selfbench_pin}")
        else:
            sandbox = await super()._create_sandbox(**kwargs)
        if self._selfbench_record and self._image.object_id:
            self._selfbench_record.mkdir(parents=True, exist_ok=True)
            (self._selfbench_record / self._selfbench_role).write_text(self._image.object_id)
        return sandbox
