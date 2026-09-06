import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from harbor.models.task.config import NetworkMode
from harbor_e2b import SelfBenchE2BEnvironment


class E2BLifetimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_creation_uses_one_hour_and_preserves_network_policy(self):
        environment = SimpleNamespace(
            _template_name="existing-template",
            environment_name="approved-task",
            session_id="trial-id",
            _startup_env=lambda: {},
            _sandbox_create_network_options=lambda: {},
            network_policy=SimpleNamespace(network_mode=NetworkMode.NO_NETWORK),
        )
        with patch("harbor_e2b.AsyncSandbox.create", new_callable=AsyncMock) as create:
            await SelfBenchE2BEnvironment._create_sandbox(environment)
            self.assertEqual(create.await_count, 1)
            self.assertEqual(create.call_args.kwargs["timeout"], 3600)
            self.assertFalse(create.call_args.kwargs["allow_internet_access"])
            self.assertEqual(create.call_args.kwargs["metadata"]["session_id"], "trial-id")


if __name__ == "__main__":
    unittest.main()
