import { expect, test } from "bun:test";
import { restoreRunDraft } from "./run-draft";

test("run drafts reject corrupt browser state and malformed task links", () => {
  for (const invalid of ["not-json", "null", "{}", '{"draft":{"models":null}}']) {
    const state = restoreRunDraft(invalid, null);
    expect(state.submitted).toBe(false);
    expect(state.draft.models).toEqual([]);
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
