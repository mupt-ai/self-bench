import { afterEach, expect, spyOn, test } from "bun:test";
import { harnessesFromFlags } from "../src/api/cli/harness-flags.js";
import { runCli } from "../src/api/cli/main.js";
import { DEFAULT_SUBAGENT_PROMPT } from "../src/contracts/conditions.js";
import { harnessesWorkspace } from "./support/harnesses-fixture.js";

const DEEPSEEK = "deepseek-v4-pro-0813";
let close: (() => Promise<void>) | undefined;
// A developer's own `self-bench login` must not leak into these tests.
process.env.XDG_CONFIG_HOME = "/nonexistent/selfbench-test-config";
const environment = { ...process.env };
afterEach(async () => {
  await close?.();
  close = undefined;
  process.env = { ...environment };
});

test("the CLI saves a harness and runs it, as the app does", async () => {
  const { server, router, sandbox } = await harnessesWorkspace();
  close = () => server.close();
  const { secret } = await server.apiKeys.create(server.user.id, { name: "CLI", scope: "write" });
  process.env.SELFBENCH_API_URL = server.origin;
  process.env.SELFBENCH_API_KEY = secret;
  const cli = async (...args: string[]): Promise<Record<string, unknown>> => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runCli([...args, "--org", "avyay"]);
      return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    } finally {
      log.mockRestore();
    }
  };
  const created = await cli(
    ...["harness", "create", "--name", "Quiet Subagents", "--agent", "claude-code"],
    ...["--skill", "vercel/next.js", "--option", "claude-code.max_turns=30"],
    ...["--subagent-model", DEEPSEEK, "--subagent-prompt", "", "--subagent-credential", router],
  );
  expect(created.harness).toMatchObject({
    name: "Quiet Subagents",
    agent: "claude-code",
    skills: ["https://github.com/vercel/next.js"],
    harnessOptions: { "claude-code": { max_turns: 30 } },
    subagent: { catalogId: DEEPSEEK, prompt: "", credentialId: router },
  });
  const id = String((created.harness as { id: number }).id);
  const updated = await cli(
    ...["harness", "update", id, "--name", "Flash Subagents", "--subagent-model", DEEPSEEK],
  );
  expect(updated.harness).toMatchObject({
    name: "Flash Subagents",
    skills: [],
    subagent: { prompt: DEFAULT_SUBAGENT_PROMPT },
  });
  expect(((await cli("harnesses")).harnesses as unknown[]).length).toBe(1);
  // Their older command names still work.
  expect(((await cli("conditions")).harnesses as unknown[]).length).toBe(1);

  await cli(
    ...["compare", "--repo", "avyay/repo", "--model", "gpt-6-sol", "--harness", "claude-code"],
    ...["--credential", router, "--sandbox", "e2b", "--sandbox-credential", sandbox],
    ...["--task", "run-one/task-one", "--saved-harness", id, "--no-baseline"],
  );
  expect(server.starts.map((input) => [input.condition?.name, input.subagent?.prompt])).toEqual([
    ["Flash Subagents", DEFAULT_SUBAGENT_PROMPT],
  ]);
  expect(await cli("harness", "delete", id)).toEqual({ deleted: true });
  expect((await cli("harnesses")).harnesses).toEqual([]);

  expect(await harnessesFromFlags({ "saved-harness": ["3", "4"], environment: ["7"] })).toEqual({
    harnesses: [3, 4],
    environments: [7],
  });
  await expect(harnessesFromFlags({ "saved-harness": ["skills"] })).rejects.toThrow(
    "--saved-harness skills: write an ID",
  );
  // The older `ID:ENVIRONMENT_ID` pairs, with the credential beside them, still run.
  expect(
    await harnessesFromFlags({ "saved-condition": ["3:7"], "subagent-credential": router }),
  ).toEqual({ conditions: [{ saved: 3, environment: 7, subagentCredentialId: router }] });
  await expect(harnessesFromFlags({ "subagent-credential": router })).rejects.toThrow(
    "--subagent-credential needs --saved-condition",
  );
});
