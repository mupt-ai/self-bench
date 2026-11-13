import { expect, test } from "bun:test";
import { restoreRunDraft } from "./run-draft";

test("new and saved empty drafts always start with one blank model row", () => {
  const state = restoreRunDraft(null, null);
  const blank = { catalogId: "", credentialId: "", harnesses: [] };
  expect(state.draft.models).toEqual([blank]);
  const saved = JSON.stringify({ ...state, draft: { ...state.draft, models: [] } });
  expect(restoreRunDraft(saved, null).draft.models).toEqual([blank]);
});

test("run drafts reject corrupt browser state and malformed task links", () => {
  for (const invalid of ["not-json", "null", "{}", '{"draft":{"models":null}}']) {
    const state = restoreRunDraft(invalid, null);
    expect(state.submitted).toBe(false);
    expect(state.draft.models).toEqual([{ catalogId: "", credentialId: "", harnesses: [] }]);
    expect(state.draft.tasks).toEqual([]);
  }
  expect(restoreRunDraft(null, '{"task":"invalid"}').draft.tasks).toEqual([]);
});

test("restoring a submitted draft keeps its request identity and a new dataset starts fresh", () => {
  const previous = restoreRunDraft(null, '[{"runId":"one","taskId":"one"}]');
  previous.submitted = true;
  expect(restoreRunDraft(JSON.stringify(previous), null)).toEqual(previous);
  const next = restoreRunDraft(JSON.stringify(previous), '[{"runId":"two","taskId":"two"}]');
  expect(next.draft.id).not.toBe(previous.draft.id);
  expect(next.submitted).toBe(false);
  expect(next.draft.tasks).toEqual([{ runId: "two", taskId: "two" }]);
});
test("a draft keeps each row's saved harness and its repo ablations, and drops what older drafts picked for every row", () => {
  const state = restoreRunDraft(null, null);
  const restored = (draft: Record<string, unknown>) =>
    restoreRunDraft(JSON.stringify({ ...state, draft: { ...state.draft, ...draft } }), null).draft;
  const models = [
    { catalogId: "gpt-6-sol", credentialId: "router", harnesses: ["codex"], harness: 4 },
    { catalogId: "gpt-6-sol", credentialId: "router", harnesses: ["codex"] },
  ];
  const kept = restored({ models, environments: [3], baseline: false });
  expect(kept).toMatchObject({ models, environments: [3], baseline: false });
  expect(kept.models[1]).not.toHaveProperty("harness");
  // Saved harnesses were once picked for every row at once, and before that as rows of pairs.
  const older = restored({
    models: [models[1]],
    harnesses: [4],
    environments: [3],
    conditions: [
      { saved: 4, environment: 5 },
      { name: "Pack", skills: ["acme/skills"] },
    ],
  });
  expect(older).toMatchObject({ environments: [3] });
  expect(older).not.toHaveProperty("harnesses");
  expect(older).not.toHaveProperty("conditions");
  expect(older.models).toHaveLength(1);
  expect(older.models[0]).toMatchObject({ catalogId: "gpt-6-sol", harnesses: ["codex"] });
  expect(older.id).toBe(state.draft.id);
  // Without a repo ablation, a draft that left out the original tasks runs them again.
  expect(restored({ baseline: false })).not.toHaveProperty("baseline");
});

test("large selections round-trip through task links and saved drafts without truncation", () => {
  const tasks = Array.from({ length: 25 }, (_, index) => ({
    runId: "run",
    taskId: `task-${index}`,
  }));
  const query = new URLSearchParams({ tasks: JSON.stringify(tasks) });
  const state = restoreRunDraft(null, query.get("tasks"));
  expect(state.draft.tasks).toEqual(tasks);
  expect(restoreRunDraft(JSON.stringify(state), null).draft.tasks).toEqual(tasks);
});
