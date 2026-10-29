"""Harbor agents for trials on SelfBench's model gateway: Codex over HTTPS with the gateway's full
model id, Pi with a provider at the gateway, and Codex and Claude Code installs that work on any
task image."""
import json
import shlex
from typing import Any
from harbor.agents.installed.claude_code import ClaudeCode
from harbor.agents.installed.codex import Codex
from harbor.agents.installed.pi import Pi, PiOptions
from harbor.agents.model_connection import ModelConnectionSpec


class SkipsSystemNode:
    async def ensure_system_dependencies(self, environment, dependencies):
        # Codex and Claude Code use the system's Node and npm only for their Alpine npm install;
        # elsewhere they install through nvm or a native installer that needs curl and bash.
        # Harbor 0.23 installs every listed package once one command is missing, and Debian's npm
        # conflicts with an image's NodeSource Node ("held broken packages"), so Codex never ran on
        # DeepSWE images that lack only rg. Skipping them also spares images without Node an
        # apt-get run, which fails on expired snapshot mirrors and can outlast the setup time.
        if await self._get_system_package_manager(environment) != "apk":
            dependencies = tuple(name for name in dependencies if name not in ("nodejs", "npm"))
        await super().ensure_system_dependencies(environment, dependencies)


# The gateway's id for a model on an OpenAI key or ChatGPT sign-in (gatewayRequestModel).
OPENAI_MODELS = "dari/model/openai/"


class GatewayCodex(SkipsSystemNode, Codex):
    def _build_effective_config(self, openai_base_url=None):
        # Codex tries the Responses API over a WebSocket first, which the gateway (and a custom
        # endpoint) need not serve: give it a provider that speaks HTTPS only. Codex also asks
        # for a reasoning summary on every turn, which the gateway refuses (`reasoning.summary is
        # not supported`), so no turn would start: ask for none.
        config = super()._build_effective_config(None)
        if openai_base_url:
            config["model_reasoning_summary"] = "none"
            # The gateway serves Codex's hosted web search tool only on OpenAI's own models and
            # refuses every turn that offers it to another (`unsupported_tool`).
            model = (getattr(self, "model_name", None) or "").removeprefix("openai/")
            if not model.startswith(OPENAI_MODELS):
                config["web_search"] = "disabled"
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
        command = 'export NVM_DIR="$HOME/.nvm"; ' + command
        if "codex exec " in command:
            # Harbor's adapter keeps only the model name's last segment, but the gateway serves
            # `dari/model/<provider>/<model>` (the runner passes it as `openai/dari/model/...`).
            model = self.model_name.removeprefix("openai/")
            original = f"--model {self.model_name.split('/')[-1]} "
            if command.count(original) != 1:
                raise ValueError("Harbor Codex command changed; cannot preserve gateway model ID")
            command = command.replace(original, f"--model {shlex.quote(model)} ", 1)
        return await super().exec_as_agent(environment, command=command, **kwargs)


class SelfBenchClaudeCode(SkipsSystemNode, ClaudeCode):
    def __init__(self, *args, subagent_model=None, **kwargs):
        super().__init__(*args, **kwargs)
        self.subagent_model = subagent_model

    async def exec_as_agent(self, environment, command, **kwargs):
        # Harbor pins this variable to the parent with custom base URLs. Override at the
        # execution boundary, after Harbor has built its env, without mutating shared state.
        if self.subagent_model and kwargs.get("env") is not None:
            kwargs["env"] = {**kwargs["env"], "CLAUDE_CODE_SUBAGENT_MODEL": self.subagent_model}
        return await super().exec_as_agent(environment, command=command, **kwargs)

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


class GatewayPiOptions(PiOptions):
    # Pi's models.json: a provider at the gateway serving the trial's one model (piGatewayModels).
    models_json: dict[str, Any] | None = None


class GatewayPi(Pi):
    # The runner names the model `selfbench/dari/model/...`, a provider Harbor does not know, so
    # Harbor writes no models.json of its own and passes Pi only the gateway key.
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True, api_key_envs=("OPENAI_API_KEY",))
    options_model = GatewayPiOptions

    async def run(self, instruction, environment, context):
        if not self.options.models_json:
            raise ValueError("GatewayPi needs the gateway's models.json")
        # Pi reads models.json from its own directory, which Harbor leaves at its default.
        models = shlex.quote(json.dumps(self.options.models_json))
        await self.exec_as_agent(
            environment,
            command=(
                'mkdir -p "$HOME/.pi/agent" && '
                f'printf %s {models} > "$HOME/.pi/agent/models.json"'
            ),
        )
        await super().run(instruction, environment, context)
