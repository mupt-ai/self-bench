"""Isolate Codex installation, preserve gateway model IDs, and pass Pi its gateway key."""
import shlex
from harbor.agents.installed.codex import Codex
from harbor.agents.installed.pi import Pi
from harbor.agents.model_connection import ModelConnectionSpec


class SelfBenchCodex(Codex):
    async def exec_as_agent(self, environment, command, **kwargs):
        command = 'export NVM_DIR="$HOME/.nvm"; ' + command
        return await super().exec_as_agent(environment, command=command, **kwargs)


class GatewayCodex(SelfBenchCodex):
    def _build_effective_config(self, openai_base_url=None):
        # Codex tries the Responses API over a WebSocket first. OpenRouter refuses the upgrade
        # and Codex falls back to HTTPS; Vercel AI Gateway accepts it, then rejects a model it
        # serves only over HTTPS and the turn fails. Gateways get a provider that speaks HTTPS.
        config = super()._build_effective_config(None)
        if openai_base_url:
            config["model_provider"] = "gateway"
            config.setdefault("model_providers", {})["gateway"] = {
                "name": "Gateway",
                "base_url": openai_base_url,
                "env_key": "OPENAI_API_KEY",
                "wire_api": "responses",
                "supports_websockets": False,
            }
        return config

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


class GatewayPi(Pi):
    # Harbor knows Vercel AI Gateway only as vercel_ai_gateway, keyed by VERCEL_AI_GATEWAY_API_KEY,
    # so Pi's vercel-ai-gateway provider would start without AI_GATEWAY_API_KEY, the key it reads.
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True, api_key_envs=("AI_GATEWAY_API_KEY",))
