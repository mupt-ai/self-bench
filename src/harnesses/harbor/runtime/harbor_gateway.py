"""Harbor agents for trials on SelfBench's model gateway: Codex over HTTPS only, Pi with the
gateway's model details, Codex and Claude Code installs that work on any task image, and both
with their subagents on a second model when the run names one."""
import json
import shlex
import shutil
import tempfile
from pathlib import Path
from typing import Any
from harbor.agents.installed.claude_code import ClaudeCode, ClaudeCodeOptions
from harbor.agents.installed.codex import Codex, CodexOptions
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
# A run with a subagent model measures the two models working together, so its agent is told to
# delegate: left to itself it may do the whole task on the run's own model.
SUBAGENT_REQUIRED_PROMPT = (
    "You must figure out how to delegate a meaningful part of this task to at least one subagent. "
    "Spawn the subagent, wait for its result, and use that result before finishing."
)


def with_subagent_prompt(existing):
    return f"{existing}\n\n{SUBAGENT_REQUIRED_PROMPT}" if existing else SUBAGENT_REQUIRED_PROMPT


def parent_rollout(sessions):
    """The rollout of the session Codex was started with, when its subagents left others beside
    it: every subagent is a thread with a rollout of its own, whose first line says a subagent
    started it (`source: {"subagent": ...}`). None when there is one rollout or none to tell apart."""
    rollouts = sorted(Path(sessions).rglob("rollout-*.jsonl"), key=lambda path: path.name)
    if len(rollouts) < 2:
        return None
    parents = []
    for rollout in rollouts:
        try:
            with open(rollout, encoding="utf-8") as lines:
                source = json.loads(lines.readline()).get("payload", {}).get("source")
        except (OSError, ValueError, AttributeError):
            continue
        if not (isinstance(source, dict) and "subagent" in source):
            parents.append(rollout)
    # Rollouts are named by when they started, and the parent starts first.
    return parents[0] if parents else None


class GatewayCodexOptions(CodexOptions):
    # Whether the trial's model reads images (acceptsImages). Codex offers its view_image tool to
    # every model, and a model that views a screenshot puts an image in the conversation, which an
    # endpoint without an image model refuses, failing the trial.
    view_image: bool = True
    # The gateway's name for the model Codex's subagents run on (EvaluationInput.subagent).
    subagent_model: str | None = None


class GatewayCodex(RetriesInstall, SkipsSystemNode, Codex):
    options_model = GatewayCodexOptions

    def _build_effective_config(self, openai_base_url=None):
        # Codex tries the Responses API over a WebSocket first, which the gateway (and a custom
        # endpoint) need not serve: give it a provider that speaks HTTPS only.
        config = super()._build_effective_config(None)
        if openai_base_url:
            # The gateway serves Codex's hosted web search tool only on OpenAI's own models and
            # refuses every turn that offers it to another (`unsupported_tool`).
            # Subagents share this config, so a subagent model that is not OpenAI's turns it off too.
            model = (getattr(self, "model_name", None) or "").removeprefix("openai/")
            models = [model, self.options.subagent_model or model]
            if not all(name.startswith(OPENAI_MODELS) for name in models):
                config["web_search"] = "disabled"
            if not self.options.view_image:
                config.setdefault("features", {})["view_image"] = False
            config["model_provider"] = "gateway"
            config.setdefault("model_providers", {})["gateway"] = {
                "name": "Gateway",
                "base_url": openai_base_url,
                "env_key": "OPENAI_API_KEY",
                "wire_api": "responses",
                "supports_websockets": False,
            }
        # Codex's subagents inherit the gateway provider; only the model they ask it for changes.
        if self.options.subagent_model:
            config.setdefault("agents", {}).update({
                "enabled": True,
                "default_subagent_model": self.options.subagent_model,
            })
            config["developer_instructions"] = with_subagent_prompt(config.get("developer_instructions"))
        return config

    async def exec_as_agent(self, environment, command, **kwargs):
        # An image may set NVM_DIR elsewhere, where Harbor's install did not put Node or Codex.
        command = 'export NVM_DIR="$HOME/.nvm"; ' + command
        return await super().exec_as_agent(environment, command=command, **kwargs)

    def convert_trajectory(self, logs_dir):
        # Harbor converts the rollout that sorts last, which after a subagent ran is a subagent's.
        # The trial's transcript is the session Codex was started with.
        parent = parent_rollout(Path(logs_dir) / "sessions") if self.options.subagent_model else None
        if parent is None:
            return super().convert_trajectory(logs_dir)
        with tempfile.TemporaryDirectory() as only:
            shutil.copy(parent, only)
            return self._convert_events_to_trajectory(Path(only))


class SelfBenchClaudeCodeOptions(ClaudeCodeOptions):
    # The gateway's name for the model Claude Code's subagents run on (EvaluationInput.subagent).
    subagent_model: str | None = None


class SelfBenchClaudeCode(RetriesInstall, SkipsSystemNode, ClaudeCode):
    options_model = SelfBenchClaudeCodeOptions

    def build_cli_flags(self):
        if not self.options.subagent_model:
            return super().build_cli_flags()
        # Added to any system prompt a run condition appends, for this command only.
        given = self.options.append_system_prompt
        self.options.append_system_prompt = with_subagent_prompt(given)
        try:
            return super().build_cli_flags()
        finally:
            self.options.append_system_prompt = given

    async def exec_as_agent(self, environment, command, **kwargs):
        # With a base URL, Harbor points every Claude tier and the subagent model at the run's own
        # model. The subagents' model replaces that one here, once Harbor has built the command's
        # environment, and FORCE keeps it whatever model a subagent's definition or the Agent
        # tool's own `model` argument names: the trial's key serves no third model.
        if self.options.subagent_model and kwargs.get("env") is not None:
            kwargs["env"] = {
                **kwargs["env"],
                "CLAUDE_CODE_SUBAGENT_MODEL": self.options.subagent_model,
                "CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1",
            }
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
