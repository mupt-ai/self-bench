import { afterEach, expect, test } from "bun:test";
import { submitRunBatch, UnsavedRunBatchError } from "./run-batch-submission";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function responses(...items: Response[]) {
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    const response = items.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  }) as typeof fetch;
  return calls;
}

const failure = () => Response.json({ error: "Submission failed" }, { status: 400 });

test("recovers an already saved batch after a failed submission response", async () => {
  const calls = responses(failure(), Response.json({ id: "same-id" }));
  expect(await submitRunBatch("/evaluations", { id: "same-id" })).toEqual({ id: "same-id" });
  expect(calls).toEqual([
    { url: "/evaluations/batches", method: "POST" },
    { url: "/evaluations/batches/same-id", method: "GET" },
  ]);
});

test("a saved batch with runs never started is flagged for resume", async () => {
  responses(failure(), Response.json({ id: "same-id", runs: [{ id: "a", status: "pending" }] }));
  expect((await submitRunBatch("/evaluations", { id: "same-id" })).submissionError).toContain(
    "Submission failed",
  );
});

test("a saved batch whose runs all started is not flagged", async () => {
  responses(failure(), Response.json({ id: "same-id", runs: [{ id: "a", status: "running" }] }));
  expect((await submitRunBatch("/evaluations", { id: "same-id" })).submissionError).toBeUndefined();
});

test("only a confirmed missing batch unlocks the submitted draft", async () => {
  responses(failure(), Response.json({ error: "Batch not found" }, { status: 404 }));
  await expect(submitRunBatch("/evaluations", { id: "same-id" })).rejects.toBeInstanceOf(
    UnsavedRunBatchError,
  );
});

test("an unavailable lookup keeps submission uncertain", async () => {
  responses(failure(), Response.json({}, { status: 503 }));
  let caught: unknown;
  try {
    await submitRunBatch("/evaluations", { id: "same-id" });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(UnsavedRunBatchError);
});
