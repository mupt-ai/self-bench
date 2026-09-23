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

test("unsubmitted drafts move old catalog ids to the shared ones; submitted drafts keep them", () => {
  const state = restoreRunDraft(null, null);
  const old = { catalogId: "openai-sol56", credentialId: "", harnesses: [] };
  const saved = (submitted: boolean) =>
    JSON.stringify({ ...state, submitted, draft: { ...state.draft, models: [old] } });
  expect(restoreRunDraft(saved(false), null).draft.models[0]?.catalogId).toBe("gpt-5.6-sol");
  expect(restoreRunDraft(saved(true), null).draft.models[0]?.catalogId).toBe("openai-sol56");
});
