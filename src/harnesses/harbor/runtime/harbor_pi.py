"""Give Pi only the trial's ChatGPT sign-in, never the worker's own login."""
import shlex
from pathlib import Path

from harbor.agents.installed.pi import Pi


class SelfBenchPi(Pi):
    async def exec_as_agent(self, environment, command, **kwargs):
        if "pi --print " in command:
            auth_path = self._get_env("SELFBENCH_PI_AUTH_JSON_PATH")
            if not auth_path:
                raise ValueError("Pi subscription credential is missing")
            remote = "/tmp/harbor-pi-auth.json"
            await environment.upload_file(Path(auth_path), remote)
            if environment.default_user is not None:
                await self.exec_as_root(
                    environment,
                    command=(
                        f"chown {shlex.quote(str(environment.default_user))} {remote} && "
                        f"chmod 600 {remote}"
                    ),
                )
            await super().exec_as_agent(
                environment,
                command=(
                    'mkdir -p "$HOME/.pi/agent" && '
                    f'install -m 600 {remote} "$HOME/.pi/agent/auth.json" && '
                    f"rm {remote}"
                ),
            )
        return await super().exec_as_agent(environment, command=command, **kwargs)
