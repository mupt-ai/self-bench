"""Retain Dari's response prices independently of Pi's transcript or catalog pricing."""
import shlex
from pathlib import Path
from harbor.agents.installed.pi import Pi


class DariPi(Pi):
    async def exec_as_agent(self, environment, command, **kwargs):
        marker = "pi --print --mode json "
        if marker in command:
            if command.count(marker) != 1:
                raise ValueError("Harbor Pi command changed; cannot install response pricing")
            capture = Path(__file__).with_name("dari_capture.cjs").read_text()
            await super().exec_as_agent(
                environment,
                command="mkdir -p /logs/agent && printf %s " + shlex.quote(capture)
                + " > /logs/agent/dari_capture.cjs && : > /logs/agent/dari-billing.jsonl",
            )
            command = command.replace(
                marker,
                marker + "--extension /logs/agent/dari_capture.cjs ",
                1,
            )
        return await super().exec_as_agent(environment, command, **kwargs)
