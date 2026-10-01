"""Give each sandboxed harness only the trial's ChatGPT sign-in, never the worker's own login."""
import shlex
from dataclasses import replace
from pathlib import Path

from harbor.agents.installed.mini_swe_agent import MiniSweAgent
from harbor.agents.installed.pi import Pi


async def install_auth(agent, environment, run, auth_env, target):
    """Copy the trial's auth file from the worker to `target` in the agent's home."""
    auth_path = agent._get_env(auth_env)
    if not auth_path:
        raise ValueError("ChatGPT sign-in credential is missing")
    remote = "/tmp/harbor-subscription-auth.json"
    await environment.upload_file(Path(auth_path), remote)
    if environment.default_user is not None:
        await agent.exec_as_root(
            environment,
            command=(
                f"chown {shlex.quote(str(environment.default_user))} {remote} && "
                f"chmod 600 {remote}"
            ),
        )
    await run(
        environment,
        command=(
            f'mkdir -p "$(dirname "{target}")" && '
            f'install -m 600 {remote} "{target}" && '
            f"rm {remote}"
        ),
    )


class SelfBenchPi(Pi):
    async def exec_as_agent(self, environment, command, **kwargs):
        if "pi --print " in command:
            await install_auth(
                self,
                environment,
                super().exec_as_agent,
                "SELFBENCH_PI_AUTH_JSON_PATH",
                "$HOME/.pi/agent/auth.json",
            )
        return await super().exec_as_agent(environment, command=command, **kwargs)


class ChatGptMiniSweAgent(MiniSweAgent):
    @property
    def model_connection(self):
        # LiteLLM's chatgpt provider signs in from its auth file, but Harbor refuses to start
        # mini-swe-agent without a key; this one never leaves Harbor's process.
        return replace(super().model_connection, api_key="chatgpt-sign-in")

    async def exec_as_agent(self, environment, command, **kwargs):
        if "mini-swe-agent --yolo " in command:
            await install_auth(
                self,
                environment,
                super().exec_as_agent,
                "SELFBENCH_CHATGPT_AUTH_JSON_PATH",
                "$HOME/.config/litellm/chatgpt/auth.json",
            )
            # The ChatGPT backend serves only the Responses API.
            if command.count("-c mini ") != 1:
                raise ValueError("Harbor mini-swe-agent command changed; cannot select Responses")
            command = command.replace(
                "-c mini ", "-c mini -c model.model_class=litellm_response ", 1
            )
        return await super().exec_as_agent(environment, command=command, **kwargs)
