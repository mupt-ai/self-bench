"""Daytona pulls portable images with a short-lived registry entry scoped to this task."""

from __future__ import annotations

from uuid import uuid4

from daytona_api_client_async.api.docker_registry_api import DockerRegistryApi
from daytona_api_client_async.models.create_docker_registry import CreateDockerRegistry
from harbor.environments.daytona import DaytonaEnvironment
from registry_auth import registry_login, stage_compose_login


class SelfBenchDaytonaEnvironment(DaytonaEnvironment):
    async def _sdk_upload_dir(self, source_dir, target_dir):
        if self._compose_mode and registry_login():
            result = await self._sandbox_exec("mkdir -p /root/.docker", user="root")
            if result.return_code != 0:
                raise RuntimeError("Could not prepare compose registry authentication")
            await stage_compose_login(self._sdk_upload_file)
        return await super()._sdk_upload_dir(source_dir, target_dir)

    async def _create_sandbox(self, params, daytona=None):
        login = registry_login()
        image = self.task_env_config.docker_image
        if self._compose_mode or not login or not image or not image.startswith(f"{login[0]}/"):
            return await super()._create_sandbox(params=params, daytona=daytona)
        client = daytona or await self._client_manager.get_client()
        registry = DockerRegistryApi(client._api_client)
        host, username, password = login
        # Different tasks use different registry projects, avoiding cross-task credential races.
        project = image.removeprefix(f"{host}/").split("@", 1)[0]
        entry = await registry.create_registry(CreateDockerRegistry(
            name=f"selfbench-{uuid4().hex}", url=host, project=project,
            username=username, password=password,
        ))
        try:
            return await super()._create_sandbox(params=params, daytona=client)
        finally:
            await registry.delete_registry(entry.id)

    async def start(self, force_build):
        try:
            return await super().start(force_build)
        finally:
            if self._compose_mode and self._sandbox and registry_login():
                result = await self._sandbox_exec("rm -f /root/.docker/config.json", user="root")
                if result.return_code != 0:
                    raise RuntimeError("Could not clear compose registry authentication")
