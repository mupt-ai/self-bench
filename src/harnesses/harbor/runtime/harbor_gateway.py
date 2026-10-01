"""Isolate Codex installation, preserve gateway model IDs, make Claude Code install reliably, and
pass Pi its gateway key."""
import shlex
from harbor.agents.installed.claude_code import ClaudeCode
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


class SelfBenchClaudeCode(ClaudeCode):
    async def install(self, environment):
        # Modal starts Python images with HOME's .cache/uv created as root, so a non-root agent
        # cannot create the .cache/claude the native installer writes to.
        user = environment.default_user
        if user is not None and str(user) not in ("root", "0"):
            user = shlex.quote(str(user))
            await self.exec_as_root(
                environment,
                command=(
                    f'home="$(getent passwd {user} | cut -d: -f6)"; '
                    f'if [ -n "$home" ]; then mkdir -p "$home/.cache" && chown {user} "$home/.cache"; fi'
                ),
            )
        await super().install(environment)

    async def ensure_system_dependencies(self, environment, dependencies):
        # Node and npm serve only the Alpine npm install; the native installer needs curl and
        # bash. Skipping them spares images that lack Node an apt-get run, which fails on
        # expired snapshot mirrors and can outlast the agent's setup time.
        if await self._get_system_package_manager(environment) != "apk":
            dependencies = tuple(name for name in dependencies if name not in ("nodejs", "npm"))
        await super().ensure_system_dependencies(environment, dependencies)


class GatewayPi(Pi):
    # Harbor knows Vercel AI Gateway only as vercel_ai_gateway, keyed by VERCEL_AI_GATEWAY_API_KEY,
    # so Pi's vercel-ai-gateway provider would start without AI_GATEWAY_API_KEY, the key it reads.
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True, api_key_envs=("AI_GATEWAY_API_KEY",))
