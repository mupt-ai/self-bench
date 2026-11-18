import { expect, test } from "bun:test";
import type { EvaluationRun } from "./api";
import { missingWork } from "./run-missing";
import { credentials, newId, run, tasks } from "./run-missing-fixture";

test("a configuration's Run Missing fills only its own runs' gaps, on its harness", () => {
  const sol = run("sol", "codex", { t1: "completed" });
  const luna = run("luna", "codex", { t1: "completed" });
  const solPi = run("sol", "pi", {});
  const work = missingWork([sol, luna, solPi], tasks, credentials, newId, undefined, {
    harness: "codex",
    runIds: new Set([sol.id]),
  });
  expect(work?.settings).toEqual([{ label: "SOL · Codex · high", harness: "codex", missing: 2 }]);
  expect(work?.trials).toBe(2);
  expect(
    missingWork([luna], tasks, credentials, newId, undefined, {
      harness: "codex",
      runIds: new Set([sol.id]),
    }),
  ).toBeUndefined();
});

test("a condition's Run Missing retries under that condition, not as the plain setting", () => {
  const condition = { id: "c1", name: "Subagents", skills: [] };
  const conditioned = run("sol", "codex", { t1: "completed" }, {
    condition,
  } as Partial<EvaluationRun>);
  const work = missingWork([conditioned], tasks, credentials, newId, undefined, {
    harness: "codex",
    runIds: new Set([conditioned.id]),
  });
  expect(work?.selections[0]).toMatchObject({
    conditions: [{ name: "Subagents", skills: [] }],
    baseline: false,
  });
});
