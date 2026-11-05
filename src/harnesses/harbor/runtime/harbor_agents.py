"""Fixes shared by SelfBench's Harbor agents (harbor_gateway.py, harbor_dari.py)."""
import asyncio
import shlex

# Each agent install is tried this many times, waiting 10 and then 20 seconds between tries.
INSTALL_ATTEMPTS = 3
INSTALL_WAIT_SECS = 10
PI_COMMAND = "pi --print --mode json "


class RetriesInstall:
    """An agent's install downloads it inside the sandbox (nvm, Node, an npm package, a native
    installer), and Harbor fails the trial on the first failed download, before the agent starts:
    a DeepSWE trial lost Pi to a TLS error partway through Node's tarball. Each step of an install
    skips or overwrites what an earlier try left, so a failed install is tried again."""

    async def install(self, environment):
        for attempt in range(INSTALL_ATTEMPTS):
            try:
                return await super().install(environment)
            except Exception:
                if attempt == INSTALL_ATTEMPTS - 1:
                    raise
                await asyncio.sleep(INSTALL_WAIT_SECS * 2**attempt)


class EndsPiOptions:
    """Harbor passes a task's instruction as Pi's last argument, so an instruction written as a
    list (`- Update the display style...`) reads as an option, and Pi exits with `Unknown option`
    before doing anything. Here `--` goes before the instruction, after which Pi (0.84.3 and later)
    reads every argument as the prompt."""

    async def run(self, instruction, environment, context):
        # Harbor's Pi quotes the instruction after rendering it through any prompt template.
        self._pi_prompt = shlex.quote(self.render_instruction(instruction))
        return await super().run(instruction, environment, context)

    async def exec_as_agent(self, environment, command, **kwargs):
        prompt = getattr(self, "_pi_prompt", None)
        if prompt is not None and PI_COMMAND in command:
            argument = f" {prompt} 2>&1 "
            if command.count(argument) != 1:
                raise ValueError("Harbor Pi command changed; cannot end Pi's options before the task")
            command = command.replace(argument, f" -- {prompt} 2>&1 ", 1)
        return await super().exec_as_agent(environment, command, **kwargs)
