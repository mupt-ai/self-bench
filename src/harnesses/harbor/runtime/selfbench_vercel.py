"""Vercel mirrors portable images using scoped source auth, separate from VCR push auth."""

from __future__ import annotations

import base64

from harbor.environments.vercel import VercelSandboxEnvironment
from harbor.environments.vercel import environment as runtime
from registry_auth import registry_login, stage_compose_login


class PullAuthenticatedBuilder:
    def __init__(self, module, login, image):
        self.module = module
        self.login = login
        self.image = image

    def __getattr__(self, name):
        return getattr(self.module, name)

    async def create_sandbox(self, **kwargs):
        sandbox = await self.module.create_sandbox(**kwargs)
        host, username, password = self.login
        auth = base64.b64encode(f"{username}:{password}".encode()).decode()
        name = self.image.removeprefix(f"{host}/").split("@", 1)[0]
        module = self.module
        transform = (module.NetworkPolicyTransform(headers={"Authorization": f"Basic {auth}"}),)
        try:
            await sandbox.update_network_policy(module.NetworkPolicy.custom(allow={
                "*": (module.NetworkPolicyRule(),),
                host: (
                    module.NetworkPolicyRule(transform=transform, match=module.NetworkPolicyRequestMatcher(
                        method=("GET", "HEAD"), path=module.NetworkPolicyMatcher.exact("/v2/"),
                    )),
                    module.NetworkPolicyRule(transform=transform, match=module.NetworkPolicyRequestMatcher(
                        method=("GET", "HEAD"),
                        path=module.NetworkPolicyMatcher.starts_with(f"/v2/{name}/"),
                    )),
                ),
            }))
        except BaseException:
            await sandbox.destroy()
            raise
        return sandbox


class SelfBenchVercelEnvironment(VercelSandboxEnvironment):
    async def _prepare_vcr_image(self, *, force_build):
        login = registry_login()
        image = self.task_env_config.docker_image
        if self._compose or not login or not image or not image.startswith(f"{login[0]}/"):
            return await super()._prepare_vcr_image(force_build=force_build)
        scope = await runtime.resolve_vcr_scope()
        self._resolved_task_image = await runtime.build_or_mirror_task_image(
            PullAuthenticatedBuilder(runtime.vercel_sandbox_module, login, image),
            scope=scope, environment_dir=self.environment_dir, docker_image=image,
            builder_image=self._builder_image,
            build_timeout_sec=int(self.task_env_config.build_timeout_sec),
            force=force_build, force_scope=str(self.trial_paths.trial_dir.parent.resolve()),
        )

    async def _sdk_upload_dir(self, source_dir, target_dir):
        if self._compose and registry_login():
            result = await self._sandbox_exec("mkdir -p /root/.docker", sudo=True)
            if result.return_code != 0:
                raise RuntimeError("Could not prepare compose registry authentication")
            await stage_compose_login(self._sdk_upload_file)
        return await super()._sdk_upload_dir(source_dir, target_dir)

    async def start(self, force_build):
        try:
            return await super().start(force_build)
        finally:
            if self._compose and self._sandbox and registry_login():
                result = await self._sandbox_exec("rm -f /root/.docker/config.json", sudo=True)
                if result.return_code != 0:
                    raise RuntimeError("Could not clear compose registry authentication")
