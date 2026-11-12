import { expect, test } from "bun:test";
import { catalog } from "../../../../src/evaluation/catalog";
import { resultsBySetting } from "../../../../src/public/release-results";
import { hasModelSelection } from "./model-selection";
import { credentials, NOW, passed, run } from "./results-fixture";
import { configurationsOf } from "./results-model";
import { retrySelection } from "./run-retry";

const subagent = {
  catalogId: "deepseek-v4-pro-0813",
  model: "openrouter/deepseek/deepseek-v4-pro-0813",
  label: "DeepSeek V4 Pro",
  credentialId: "managed-model",
};

test("the same subagent model on another credential is the same configuration", () => {
  const model = catalog[0];
  if (!model) throw new Error("Missing model");
  const keys = [
    { id: "router-a", kind: "openrouter" as const },
    { id: "vercel", kind: "vercel-ai-gateway" as const },
  ];
  const selection = {
    catalogId: model.id,
    credentialId: "router-a",
    harnesses: ["codex" as const],
    subagent: { catalogId: subagent.catalogId, credentialId: "router-a" },
  };
  // A setting names its subagent model by catalog id, whatever credential serves it.
  expect(
    hasModelSelection(
      model,
      [selection],
      { ...selection, subagent: { ...selection.subagent, credentialId: "vercel" } },
      keys,
    ),
  ).toBe(true);
  expect(
    hasModelSelection(
      model,
      [selection],
      { ...selection, subagent: { ...selection.subagent, catalogId: "gpt-6-luna" } },
      keys,
    ),
  ).toBe(false);
  const { subagent: _none, ...alone } = selection;
  expect(hasModelSelection(model, [selection], alone, keys)).toBe(false);
});

test("a retry runs a subagent model again where the run named it: its condition, or its row", () => {
  const failed = [{ ...passed("task"), status: "failed" as const, error: "Provider unavailable" }];
  const delegating = { catalogId: subagent.catalogId, prompt: "Delegate the tests." };
  const condition = {
    id: "c0ffee123456",
    name: "Flash Subagents",
    skills: [],
    subagent: delegating,
  };
  const conditioned = retrySelection(
    run("conditioned", { subagent: { ...subagent, prompt: delegating.prompt }, condition }, failed),
    "codex",
    crypto.randomUUID(),
  );
  expect(conditioned?.selection.conditions).toEqual([
    {
      name: "Flash Subagents",
      skills: [],
      subagent: { ...delegating, credentialId: subagent.credentialId },
    },
  ]);
  expect(conditioned?.selection.models[0]?.subagent).toBeUndefined();
  // A run from before conditions named subagent models named its own on its row.
  const row = retrySelection(run("row", { subagent }, failed), "codex", crypto.randomUUID());
  expect(row?.selection.models[0]?.subagent).toEqual({
    catalogId: subagent.catalogId,
    credentialId: subagent.credentialId,
  });
  expect(row?.selection.conditions).toBeUndefined();
});

test("results and releases keep a model apart from itself with a subagent model", () => {
  const condition = { id: "c0ffee123456", name: "With Skills", skills: ["org/repo"] };
  const alone = run("alone", {}, [passed("task")]);
  const mixed = run("mixed", { subagent }, [passed("task")]);
  // The same subagent model on another credential is the same setting.
  const rerouted = run("rerouted", { subagent: { ...subagent, credentialId: "other" } }, [
    passed("other-task"),
  ]);
  const conditioned = run("conditioned", { subagent, condition }, [passed("task")]);
  const app = configurationsOf([alone, mixed, rerouted, conditioned], credentials, NOW);
  expect(app.map((entry) => [entry.label, entry.condition?.name, entry.latest.length])).toEqual(
    expect.arrayContaining([
      [alone.modelLabel, undefined, 1],
      [`${alone.modelLabel} + DeepSeek V4 Pro Subagents`, undefined, 2],
      [`${alone.modelLabel} + DeepSeek V4 Pro Subagents`, "With Skills", 1],
    ]),
  );
  expect(app).toHaveLength(3);
  expect(new Set(app.map((entry) => entry.key)).size).toBe(3);
  const mixedKey = app.find((entry) => entry.subagent && !entry.condition)?.key ?? "";
  expect(JSON.parse(mixedKey).at(-1)).toBe("subagent:deepseek-v4-pro-0813");
  const conditionedKey = app.find((entry) => entry.condition)?.key ?? "";
  expect(JSON.parse(conditionedKey).slice(-2)).toEqual([
    condition.id,
    "subagent:deepseek-v4-pro-0813",
  ]);
  // A model alone keeps the key it always had.
  expect(JSON.parse(app.find((entry) => !entry.subagent)?.key ?? "[]")).toHaveLength(3);
  const released = [...resultsBySetting([alone, mixed, rerouted]).values()];
  expect(released.map((entry) => entry.setting.label).sort()).toEqual(
    [alone.modelLabel, `${alone.modelLabel} + DeepSeek V4 Pro Subagents`].sort(),
  );
  expect(released.find((entry) => entry.setting.subagent)?.setting).toMatchObject({
    id: expect.stringMatching(/\|subagent:deepseek-v4-pro-0813$/),
    subagent: { catalogId: "deepseek-v4-pro-0813", label: "DeepSeek V4 Pro" },
  });
});
