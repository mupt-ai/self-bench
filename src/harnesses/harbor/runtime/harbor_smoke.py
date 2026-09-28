"""Run a task's smoke command where the solver runs: its image, user, and network allowlist."""
from harbor.agents.base import BaseAgent

SMOKE = "/opt/selfbench-environment/smoke.sh 2>&1"
# Whatever smoke wrote outside .gitignore stays out of agent.patch, so nop grades the snapshot.
RESTORE = "git -C /app reset -q --hard && git -C /app clean -fdq"
OUTPUT_LIMIT = 200_000


class SmokeCheckFailed(Exception):
    """Ends the trial before the verifier: nop results are meaningless if the agent is stuck."""


class SmokeAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "selfbench-smoke"

    def version(self) -> str:
        return "1.0.0"

    async def setup(self, environment) -> None:
        pass

    async def run(self, instruction, environment, context) -> None:
        # Harbor calls run() inside the agent phase: [agent] user and network policy both apply.
        result = await environment.exec(SMOKE)
        context.metadata = {
            "smoke_exit_code": result.return_code,
            "smoke_output": (result.stdout or "")[-OUTPUT_LIMIT:],
        }
        if result.return_code != 0:
            raise SmokeCheckFailed(f"smoke command exited {result.return_code}")
        restore = await environment.exec(RESTORE)
        if restore.return_code != 0:
            raise RuntimeError(f"could not restore /app after smoke: {restore.stdout or ''}")
