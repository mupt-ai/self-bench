"""Harbor's Modal environment, started from a task's pinned image when it has one.

A task's verification builds its agent image (from ``environment/``) and its verifier image
(from ``tests/``) on Modal; the worker records the image each sandbox started from and keeps the
IDs with the accepted task. A trial passes them back as ``agent_image`` / ``verifier_image``
environment kwargs and starts from ``Image.from_id``, so it neither resolves nor builds the
Dockerfile. A pin Modal no longer knows (another workspace, or an image Modal dropped) falls
back to the Dockerfile build Harbor would have done. Compose tasks (Harbor's Docker-in-Docker
strategy) never pin: their sandbox image is the DinD host, not the task. Every sandbox also
gets a lifetime and an idle limit, so one whose trial stopped without cleaning up ends itself.
"""

from __future__ import annotations

import os
from pathlib import Path

from modal import Image, Secret
from modal.exception import InvalidError, NotFoundError, PermissionDeniedError

from harbor.environments.modal import ModalEnvironment
from registry_auth import ROLES as _ROLES
from registry_auth import registry_login, stage_compose_login

# What Modal raises for an image ID this workspace cannot use; anything else is a real failure.
UNUSABLE_PIN = (NotFoundError, PermissionDeniedError, InvalidError)

# Harbor's defaults keep a sandbox for a day with no idle limit, so a trial stopped mid-run
# (cancelled, timed out, or its worker replaced) left its sandbox running for 24 hours. No Harbor
# process outlives the 3-hour gate cap (HARBOR_PROCESS_TIMEOUT_MS) or a solver trial with the most
# agent minutes (trialTimeouts, under 3 hours), and Modal counts a sandbox
# with a command running as active, so a live trial never sits idle for half an hour.
SANDBOX_LIFETIME_SECS = 3 * 60 * 60
SANDBOX_IDLE_SECS = 30 * 60


class SelfBenchModalEnvironment(ModalEnvironment):
    def __init__(
        self,
        *args,
        agent_image: str | None = None,
        verifier_image: str | None = None,
        image_record_dir: str | None = None,
        sandbox_timeout_secs: int = SANDBOX_LIFETIME_SECS,
        sandbox_idle_timeout_secs: int | None = SANDBOX_IDLE_SECS,
        **kwargs,
    ):
        super().__init__(
            *args,
            sandbox_timeout_secs=sandbox_timeout_secs,
            sandbox_idle_timeout_secs=sandbox_idle_timeout_secs,
            **kwargs,
        )
        self._selfbench_role = _ROLES.get(self.environment_dir.name)
        pins = {"agent": agent_image, "verifier": verifier_image}
        self._selfbench_pin = pins.get(self._selfbench_role) if self._selfbench_role else None
        self._selfbench_record = Path(image_record_dir) if image_record_dir else None

    async def _sdk_upload_dir(self, source_dir, target_dir):
        if self._compose_mode and registry_login():
            result = await self._sdk_exec("mkdir -p /root/.docker")
            if result.return_code != 0:
                raise RuntimeError("Could not prepare compose registry authentication")
            await stage_compose_login(self._sdk_upload_file)
        return await super()._sdk_upload_dir(source_dir, target_dir)

    async def start(self, force_build):
        try:
            return await super().start(force_build)
        finally:
            if self._compose_mode and self._sandbox and registry_login():
                result = await self._sdk_exec("rm -f /root/.docker/config.json")
                if result.return_code != 0:
                    raise RuntimeError("Could not clear compose registry authentication")

    async def _create_sandbox(self, **kwargs):
        if self._compose_mode or self._selfbench_role is None:
            return await super()._create_sandbox(**kwargs)
        image = self.task_env_config.docker_image
        host = os.environ.get("SELFBENCH_REGISTRY_HOST")
        password = os.environ.get("SELFBENCH_REGISTRY_PASSWORD")
        if image and host and password and image.startswith(f"{host}/"):
            # The short-lived grant is only a registry build secret, never sandbox env.
            self._image = Image.from_registry(
                image,
                secret=Secret.from_dict({
                    "REGISTRY_USERNAME": os.environ["SELFBENCH_REGISTRY_USERNAME"],
                    "REGISTRY_PASSWORD": password,
                }),
            )
        if self._selfbench_pin:
            built = self._image
            self._image = Image.from_id(self._selfbench_pin)
            try:
                sandbox = await super()._create_sandbox(**kwargs)
            except UNUSABLE_PIN:
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
