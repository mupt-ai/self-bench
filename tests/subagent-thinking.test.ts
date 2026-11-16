import { afterEach, expect, test } from "bun:test";
import { findModel } from "../src/contracts/models.js";
import { harnessesWorkspace } from "./support/harnesses-fixture.js";

// A saved harness's subagent thinking level: the level every subagent call of its runs is served
// at, in place of the subagent model's default.

const DEEPSEEK = "deepseek-v4-pro-0813";
const LABEL = findModel(DEEPSEEK)?.label ?? "";
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

test("a harness's subagents run at the thinking level it picks, which must be one their model has", async () => {
  const { server, router, save, row, compare } = await harnessesWorkspace();
  close = () => server.close();
  const subagent = { catalogId: DEEPSEEK, prompt: "Delegate the tests." };
  const plain = await save({ name: "Flash Subagents", subagent });
  const low = await save({ name: "Low Subagents", subagent: { ...subagent, thinking: "low" } });
  expect(low.status).toBe(201);
  expect(low.harness.subagent).toEqual({ ...subagent, thinking: "low" });
  // DeepSeek has off, low, high, and max; its default is no level to name.
  expect(
    await save({ name: "Medium", subagent: { ...subagent, thinking: "medium" } }),
  ).toMatchObject({
    status: 400,
    error: `subagent.thinking: ${LABEL} has no medium level; it offers off, low, high, max`,
  });
  expect(
    (await save({ name: "Default", subagent: { ...subagent, thinking: "default" } })).status,
  ).toBe(400);

  const only = { models: [row("gpt-6-sol", "claude-code")], baseline: false as const };
  const { error, started } = await compare({
    ...only,
    harnesses: [plain.harness.id, low.harness.id],
  });
  expect(error).toBeUndefined();
  // Frozen as served: the level picked, or else the one a row of the model runs at by default.
  expect(started.map((input) => [input.condition?.name, input.subagent?.thinking])).toEqual([
    ["Flash Subagents", "high"],
    ["Low Subagents", "low"],
  ]);
  // The level is part of what the harness changes, so results keep the two apart.
  const [defaulted, leveled] = started.map((input) => input.condition);
  expect(defaulted?.subagent).toEqual(subagent);
  expect(leveled?.subagent).toEqual({ ...subagent, thinking: "low" });
  expect(leveled?.id).not.toBe(defaulted?.id);

  // Changes written out, as a retry repeats a run, are checked when the run starts: on the
  // credential named, or against every credential that could serve the model.
  const written = { name: "Medium", skills: [], subagent: { ...subagent, thinking: "medium" } };
  expect((await compare({ ...only, conditions: [written] })).error).toBe(
    `Medium: no saved credential serves ${LABEL} to subagents at medium thinking`,
  );
  const named = { ...written, subagent: { ...written.subagent, credentialId: router } };
  expect((await compare({ ...only, conditions: [named] })).error).toBe(
    `Medium: ${LABEL} has no medium thinking level on this credential: it offers off, low, high, max`,
  );
});
