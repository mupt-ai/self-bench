import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../src/lib/process.js";

// Harbor itself is stubbed: the adapter is checked for what it asks the agent environment to run
// and what it reports, not for Harbor's own user and network handling.
test("the smoke agent reports smoke's outcome and leaves /app as the snapshot", async () => {
  const result = await runCommand("python3", [
    "-c",
    `import asyncio, importlib.util, sys, types
module = types.ModuleType("harbor.agents.base")
class BaseAgent:
    pass
module.BaseAgent = BaseAgent
sys.modules[module.__name__] = module
spec = importlib.util.spec_from_file_location("adapter", sys.argv[1])
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
class Result:
    def __init__(self, code, out):
        self.return_code, self.stdout = code, out
class Environment:
    def __init__(self, smoke_code):
        self.smoke_code, self.commands = smoke_code, []
    async def exec(self, command, **kwargs):
        self.commands.append(command)
        return Result(self.smoke_code if "smoke.sh" in command else 0, "pnpm 9.1.0" if "smoke.sh" in command else "")
class Context:
    metadata = None
async def check():
    passing, context = Environment(0), Context()
    await adapter.SmokeAgent().run("", passing, context)
    assert context.metadata == {"smoke_exit_code": 0, "smoke_output": "pnpm 9.1.0"}, context.metadata
    assert passing.commands[0] == "/opt/selfbench-environment/smoke.sh 2>&1"
    assert "reset -q --hard" in passing.commands[1] and "clean -fdq" in passing.commands[1]
    failing, context = Environment(1), Context()
    try:
        await adapter.SmokeAgent().run("", failing, context)
        raise AssertionError("smoke failure did not raise")
    except adapter.SmokeCheckFailed:
        pass
    assert context.metadata["smoke_exit_code"] == 1
    assert len(failing.commands) == 1
asyncio.run(check())
`,
    fileURLToPath(new URL("../../src/harnesses/harbor/runtime/harbor_smoke.py", import.meta.url)),
  ]);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
});
