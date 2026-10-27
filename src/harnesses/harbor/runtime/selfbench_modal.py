"""Harbor's Modal environment, started from a task's images in SelfBench's registry.

A task whose images SelfBench built gets them as Harbor's `docker_image`, served by the API's
registry endpoint; the sandbox's image is pulled from there with the run's short-lived pull grant
(SELFBENCH_REGISTRY_*), passed only as a registry secret. Compose tasks (Harbor's
Docker-in-Docker strategy) pull inside the DinD host instead, with the grant staged there only
while it starts. Every sandbox also gets a lifetime and an idle limit, so one whose trial stopped
without cleaning up ends itself.
"""

from __future__ import annotations

from modal import Image, Secret

from harbor.environments.modal import ModalEnvironment
from registry_auth import registry_login, stage_compose_login

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
        login = registry_login()
        image = self.task_env_config.docker_image
        if not self._compose_mode and login and image and image.startswith(f"{login[0]}/"):
            # The short-lived grant is only a registry build secret, never sandbox env.
            _, username, password = login
            self._image = Image.from_registry(
                image,
                secret=Secret.from_dict({"REGISTRY_USERNAME": username, "REGISTRY_PASSWORD": password}),
            )
        return await super()._create_sandbox(**kwargs)
