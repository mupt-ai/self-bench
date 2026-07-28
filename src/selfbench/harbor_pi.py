"""Harbor Pi agent pinned to the current renamed npm package."""

from __future__ import annotations

import json
from typing import override

from harbor.agents.installed.base import UnknownApiError
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.installed.pi import Pi
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

PI_VERSION = "0.82.1"


class SelfbenchPi(Pi):
    """Pi adapter that supports current model metadata and surfaces provider errors."""

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

    @override
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
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
