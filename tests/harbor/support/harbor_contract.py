"""Builds one SelfBench trial's agent with the installed Harbor, as `harbor run` would, and runs it
against a sandbox that records what the agent asks of it instead of doing it.

Reads {agent, model, agentArguments, env, instruction} as JSON on stdin; prints {commands, files}:
each command the agent ran with the environment it set, and each file it uploaded.
"""

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

from harbor.agents.factory import AgentFactory
from harbor.cli.utils import parse_kwargs
from harbor.environments.base import ExecResult
from harbor.models.trial.config import AgentConfig

trial = json.load(sys.stdin)
os.environ.clear()
os.environ.update(trial["env"])
arguments = trial["agentArguments"]
kwargs = parse_kwargs(
    [arguments[index + 1] for index, flag in enumerate(arguments) if flag == "--agent-kwarg"]
)
agent, import_path = trial["agent"], None
if ":" in agent:
    agent, import_path = None, agent
config = AgentConfig(name=agent, import_path=import_path, model_name=trial["model"], kwargs=kwargs)


class RecordingSandbox:
    """A sandbox that answers every command with success, and asks of who runs it with root."""

    default_user = None

    def __init__(self):
        self.commands, self.files = [], {}

    async def exec(self, command, cwd=None, env=None, timeout_sec=None, user=None, **_):
        self.commands.append({"command": command, "env": env or {}, "user": user})
        # Codex reads its uid and gid from a line it prints (Codex._ensure_agent_owned_dir).
        stdout = "\nCODEX_RUNTIME_ID 0 0\n" if "CODEX_RUNTIME_ID" in command else ""
        return ExecResult(stdout=stdout, stderr="", return_code=0)

    async def upload_file(self, source_path, target_path, **_):
        self.files[str(target_path)] = Path(source_path).read_text()

    async def upload_dir(self, source_dir, target_dir, **_):
        for path in Path(source_dir).rglob("*"):
            if path.is_file():
                self.files[f"{target_dir}/{path.relative_to(source_dir)}"] = path.read_text()

    async def download_file(self, *args, **kwargs):
        pass

    async def download_dir(self, *args, **kwargs):
        pass

    def __getattr__(self, name):
        # Anything else an agent asks of its environment is a capability it may test for.
        return None


AgentFactory.run_preflight(config)
with tempfile.TemporaryDirectory() as logs:
    instance = AgentFactory.create_agent_from_config(config, logs_dir=Path(logs))
    sandbox = RecordingSandbox()
    asyncio.run(instance.run(trial["instruction"], sandbox, None))
print(json.dumps({"commands": sandbox.commands, "files": sandbox.files}))
