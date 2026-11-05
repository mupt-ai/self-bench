"""Harbor agents for trials on SelfBench's model gateway: Codex over HTTPS only, Pi with the
gateway's model details, and Codex and Claude Code installs that work on any task image."""
import shlex
from typing import Any
from harbor.agents.installed.claude_code import ClaudeCode
from harbor.agents.installed.codex import Codex
from harbor.agents.installed.pi import Pi, PiOptions
from harbor_agents import EndsPiOptions, RetriesInstall


class SkipsSystemNode:
    async def ensure_system_dependencies(self, environment, dependencies):
        # Codex and Claude Code use the system's Node and npm only for their Alpine npm install;
        # elsewhere they install through nvm or a native installer that needs curl and bash.
        # Harbor would apt-get Debian's Node and npm onto an image without them, a run that fails
        # on expired snapshot mirrors and can outlast the setup time, and Debian's npm conflicts
        # with an image's NodeSource Node ("held broken packages").
        if await self._get_system_package_manager(environment) != "apk":
            dependencies = tuple(name for name in dependencies if name not in ("nodejs", "npm"))
        await super().ensure_system_dependencies(environment, dependencies)


# The gateway's id for a model on an OpenAI key or ChatGPT sign-in (gatewayRequestModel).
OPENAI_MODELS = "dari/model/openai/"


class GatewayCodex(RetriesInstall, SkipsSystemNode, Codex):
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
        # An image may set NVM_DIR elsewhere, where Harbor's install did not put Node or Codex.
        command = 'export NVM_DIR="$HOME/.nvm"; ' + command
        return await super().exec_as_agent(environment, command=command, **kwargs)


class SelfBenchClaudeCode(RetriesInstall, SkipsSystemNode, ClaudeCode):
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
    # What the gateway knows of the trial's model (piModelDetails): its name, context window,
    # largest output and whether it reads images, which Harbor's models.json leaves out.
    model_details: dict[str, Any] | None = None


class GatewayPi(RetriesInstall, EndsPiOptions, Pi):
    """Pi on the gateway as Harbor's custom endpoint (OPENAI_BASE_URL with model_api), whose
    models.json entry also gets the model's details, so Pi sizes its context and output to it."""

    options_model = GatewayPiOptions

    def _build_custom_models_json(self, access, model_id):
        models = super()._build_custom_models_json(access, model_id)
        if models is None:
            raise ValueError("GatewayPi needs the gateway as Pi's custom endpoint")
        for provider in models["providers"].values():
            for model in provider["models"]:
                model.update(self.options.model_details or {})
        return models
