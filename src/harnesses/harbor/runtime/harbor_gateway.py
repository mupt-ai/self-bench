"""SelfBench's Harbor solver adapters.

Compiled task images carry a harness-neutral runtime (system tools and a private Node under
RUNTIME_ROOT, see src/harnesses/harbor/agent-runtime.ts). On those images a trial installs only
its pinned harness CLI; tasks compiled without the runtime fall back to Harbor's own install.
"""
import shlex
from harbor.agents.installed.claude_code import ClaudeCode
from harbor.agents.installed.codex import Codex
from harbor.agents.installed.pi import Pi

# Must match AGENT_RUNTIME_ROOT in src/harnesses/harbor/agent-runtime.ts.
RUNTIME_ROOT = "/opt/selfbench-agent-runtime"
RUNTIME_NODE_BIN = f"{RUNTIME_ROOT}/node/bin"


class PrebakedRuntime:
    """Replaces Harbor's apt and nvm install when the task image already carries the runtime."""

    _has_runtime: bool | None = None

    async def has_runtime(self, environment) -> bool:
        if self._has_runtime is None:
            result = await environment.exec(command=f"test -x {RUNTIME_NODE_BIN}/node", user="root")
            self._has_runtime = result.return_code == 0
        return self._has_runtime

    async def install_node_cli(self, environment, package: str, command: str) -> None:
        """Install an npm CLI root-owned under the runtime and expose it on /usr/local/bin.

        The runtime's Node stays off PATH, so the repository keeps its own Node: a JavaScript entry
        point gets a wrapper that names the runtime's node, and a native one is linked directly.
        """
        spec = f"{package}@{self._version}" if self._version else package
        prefix = shlex.quote(f"{RUNTIME_ROOT}/harness/{command}")
        link = shlex.quote(f"/usr/local/bin/{command}")
        node = shlex.quote(f"{RUNTIME_NODE_BIN}/node")
        await self.exec_as_root(
            environment,
            command=(
                "set -eu; "
                f"PATH={shlex.quote(RUNTIME_NODE_BIN)}:$PATH npm install --global --prefix {prefix} "
                f"--no-audit --no-fund --loglevel=error {shlex.quote(spec)}; "
                f"entry=\"$(readlink -f {prefix}/bin/{shlex.quote(command)})\"; "
                f"mkdir -p /usr/local/bin; rm -f {link}; "
                'if [ "$(head -c 2 "$entry")" = "#!" ]; then '
                f"printf '#!/bin/sh\\nexec %s %s \"$@\"\\n' {node} \"$entry\" > {link}; "
                f"chmod 755 {link}; "
                f"else ln -s \"$entry\" {link}; fi; "
                f"{shlex.quote(command)} --version"
            ),
        )


class SelfBenchCodex(PrebakedRuntime, Codex):
    async def install(self, environment):
        if not await self.has_runtime(environment):
            return await super().install(environment)
        if not await self._installed_codex_satisfies_version(environment):
            await self.install_node_cli(environment, "@openai/codex", "codex")

    async def exec_as_agent(self, environment, command, **kwargs):
        # Node images export NVM_DIR outside the agent's home; the fallback install needs its own.
        command = 'export NVM_DIR="$HOME/.nvm"; ' + command
        return await super().exec_as_agent(environment, command=command, **kwargs)


class GatewayCodex(SelfBenchCodex):
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


class SelfBenchClaudeCode(PrebakedRuntime, ClaudeCode):
    async def install(self, environment):
        if not await self.has_runtime(environment):
            return await super().install(environment)
        if not await self._installed_claude_satisfies_version(environment):
            await self.install_node_cli(environment, "@anthropic-ai/claude-code", "claude")


class SelfBenchPi(PrebakedRuntime, Pi):
    _NVM_SOURCE = ". ~/.nvm/nvm.sh; "

    async def install(self, environment):
        if not await self.has_runtime(environment):
            return await super().install(environment)
        installed = await environment.exec(command="pi --version")
        if installed.return_code != 0 or self.parse_version(installed.stdout or "") != self._version:
            await self.install_node_cli(environment, self._package_name(), "pi")

    async def exec_as_agent(self, environment, command, **kwargs):
        # Harbor sources nvm unconditionally; on the runtime there is no nvm to source.
        command = command.replace(
            self._NVM_SOURCE, "if [ -s ~/.nvm/nvm.sh ]; then . ~/.nvm/nvm.sh; fi; "
        )
        return await super().exec_as_agent(environment, command=command, **kwargs)
