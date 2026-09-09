from e2b import AsyncSandbox
from harbor.environments.e2b import E2BEnvironment
from harbor.models.task.config import NetworkMode


class SelfBenchE2BEnvironment(E2BEnvironment):
    async def _create_sandbox(self):
        self._sandbox = await AsyncSandbox.create(
            template=self._template_name,
            metadata={
                "environment_name": self.environment_name,
                "session_id": self.session_id,
            },
            envs=self._startup_env(),
            timeout=3600,
            allow_internet_access=(
                self.network_policy.network_mode != NetworkMode.NO_NETWORK
            ),
            network=self._sandbox_create_network_options(),
        )
