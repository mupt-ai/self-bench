"""Keep gateway model IDs intact in Harbor's Codex command."""
import shlex
from harbor.agents.installed.codex import Codex


class GatewayCodex(Codex):
    async def exec_as_agent(self, environment, command, **kwargs):
        if "codex exec " in command:
            # Harbor's pinned adapter keeps only the final slash component.
            # Our runner uses openai/<gateway-model-id> for its Responses endpoint.
            model = self.model_name.removeprefix("openai/")
            original = f"--model {self.model_name.split('/')[-1]} "
            if command.count(original) != 1:
                raise ValueError("Harbor Codex command changed; cannot preserve gateway model ID")
            command = command.replace(original, f"--model {shlex.quote(model)} ", 1)
        return await super().exec_as_agent(environment, command=command, **kwargs)
