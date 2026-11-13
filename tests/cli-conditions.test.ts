import { afterEach, expect, spyOn, test } from "bun:test";
import { conditionsFromFlags } from "../src/api/cli/conditions.js";
import { runCli } from "../src/api/cli/main.js";
import { DEFAULT_SUBAGENT_PROMPT } from "../src/contracts/conditions.js";
import { conditionsWorkspace } from "./support/conditions-fixture.js";

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

test("the CLI saves a condition and runs it, as the app does", async () => {
  const { server, router, sandbox } = await conditionsWorkspace();
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
    ...["condition", "create", "--name", "Quiet Subagents", "--skill", "vercel/next.js"],
    ...["--harness-option", "claude-code.max_turns=30"],
    ...["--subagent-model", DEEPSEEK, "--subagent-prompt", ""],
  );
  expect(created.condition).toMatchObject({
    name: "Quiet Subagents",
    skills: ["https://github.com/vercel/next.js"],
    harnessOptions: { "claude-code": { max_turns: 30 } },
    subagent: { catalogId: DEEPSEEK, prompt: "" },
  });
  const id = String((created.condition as { id: number }).id);
  const updated = await cli(
    ...["condition", "update", id, "--name", "Flash Subagents", "--subagent-model", DEEPSEEK],
  );
  expect(updated.condition).toMatchObject({
    name: "Flash Subagents",
    skills: [],
    subagent: { prompt: DEFAULT_SUBAGENT_PROMPT },
  });
  expect(((await cli("conditions")).conditions as unknown[]).length).toBe(1);

  await cli(
    ...["compare", "--repo", "avyay/repo", "--model", "gpt-6-sol", "--harness", "claude-code"],
    ...["--credential", router, "--sandbox", "e2b", "--sandbox-credential", sandbox],
    ...["--task", "run-one/task-one", "--saved-condition", id, "--no-baseline"],
  );
  expect(server.starts.map((input) => [input.condition?.name, input.subagent?.prompt])).toEqual([
    ["Flash Subagents", DEFAULT_SUBAGENT_PROMPT],
  ]);
  expect(await cli("condition", "delete", id)).toEqual({ deleted: true });
  expect((await cli("conditions")).conditions).toEqual([]);

  // `ID:ENVIRONMENT_ID` runs it in a repository environment, on the credential named for its subagents.
  expect(
    await conditionsFromFlags({ "saved-condition": ["3:7", "4"], "subagent-credential": router }),
  ).toEqual({
    conditions: [
      { saved: 3, environment: 7, subagentCredentialId: router },
      { saved: 4, subagentCredentialId: router },
    ],
  });
  await expect(conditionsFromFlags({ "saved-condition": ["skills"] })).rejects.toThrow(
    "write ID or ID:ENVIRONMENT_ID",
  );
  await expect(conditionsFromFlags({ "subagent-credential": router })).rejects.toThrow(
    "--subagent-credential needs --saved-condition",
  );
});
