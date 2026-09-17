import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from harbor.models.task.config import NetworkMode, EnvironmentConfig
from harbor.models.task.config import NetworkPolicy
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


class PinnedHarborCompatibilityTest(unittest.IsolatedAsyncioTestCase):
    async def test_real_pinned_helpers_preserve_env_and_allowlist(self):
        # No SDK allocation: exercise real inherited Harbor helpers, not stand-ins.
        environment = object.__new__(SelfBenchE2BEnvironment)
        environment._template_name = "template"
        environment.environment_name = "task"
        environment.session_id = "session"
        environment.task_env_config = EnvironmentConfig(env={"TASK_VALUE": "present"})
        environment._persistent_env = {"TRIAL_VALUE": "present"}
        environment._network_policy = NetworkPolicy(network_mode=NetworkMode.ALLOWLIST, allowed_hosts=["example.com"])
        with patch("harbor_e2b.AsyncSandbox.create", new_callable=AsyncMock) as create:
            await environment._create_sandbox()
            kwargs = create.call_args.kwargs
            self.assertEqual(kwargs["envs"], {"TASK_VALUE": "present", "TRIAL_VALUE": "present"})
            self.assertEqual(kwargs["network"]["allow_out"], ["example.com"])
            self.assertEqual(kwargs["timeout"], 3600)
            self.assertTrue(kwargs["allow_internet_access"])
            self.assertIs(environment._sandbox, create.return_value)


if __name__ == "__main__":
    unittest.main()
