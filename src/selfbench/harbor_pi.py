"""Harbor Pi agent pinned to the current renamed npm package."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import override

from harbor.agents.installed.base import CliFlag, UnknownApiError
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

PI_VERSION = "0.82.1"

# Path to a Pi models.json defining custom providers (e.g. an OpenAI-compatible
# router). When set, the file is installed into the sandbox before Pi runs so
# `--provider <custom>` resolves. Reference secrets as `"apiKey": "!printenv X"`
# and forward X via agent env rather than embedding key material in the file.
MODELS_JSON_FILE_ENV = "SELFBENCH_PI_MODELS_JSON_FILE"

_MODELS_JSON_HEREDOC = "SELFBENCH_MODELS_JSON_EOF"


class SelfbenchPi(Pi):
    """Pi adapter that supports current model metadata and surfaces provider errors."""

    # Harbor's bundled Pi agent predates the `max` thinking level that the
    # pinned Pi npm package supports; keep the enum in sync with that package.
    CLI_FLAGS = [
        CliFlag(
            "thinking",
            cli="--thinking",
            type="enum",
            choices=["off", "minimal", "low", "medium", "high", "xhigh", "max"],
        ),
    ]

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y curl",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                "npm install -g --ignore-scripts "
                f"@earendil-works/pi-coding-agent@{PI_VERSION} && "
                "pi --version"
            ),
        )

    async def _install_models_json(self, environment: BaseEnvironment) -> None:
        models_file = os.environ.get(MODELS_JSON_FILE_ENV)
        if not models_file:
            return
        payload = Path(models_file).read_text()
        json.loads(payload)
        if _MODELS_JSON_HEREDOC in payload:
            raise ValueError(f"models.json payload must not contain {_MODELS_JSON_HEREDOC}")
        await self.exec_as_agent(
            environment,
            command=(
                'mkdir -p "$HOME/.pi/agent" && '
                f"cat > \"$HOME/.pi/agent/models.json\" <<'{_MODELS_JSON_HEREDOC}'\n"
                f"{payload}\n{_MODELS_JSON_HEREDOC}"
            ),
        )

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        await self._install_models_json(environment)
        await super().run(instruction, environment, context)
        output_file = self.logs_dir / self._OUTPUT_FILENAME
        if not output_file.is_file():
            return
        provider_error = _provider_error(output_file.read_text(errors="replace"))
        if provider_error:
            raise UnknownApiError(f"Pi provider error: {provider_error}")


def _provider_error(output: str) -> str | None:
    for line in reversed(output.splitlines()):
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") not in {"message_start", "message_end", "turn_end"}:
            continue
        message = event.get("message")
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        if message.get("stopReason") == "error":
            return str(message.get("errorMessage") or "unknown provider error")
        return None
    return None
