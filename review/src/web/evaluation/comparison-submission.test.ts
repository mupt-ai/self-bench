import { afterEach, expect, test } from "bun:test";
import { submitComparison, UnsavedComparisonError } from "./comparison-submission";

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

test("recovers an already saved comparison after a failed submission response", async () => {
  const calls = responses(failure(), Response.json({ id: "same-id" }));
  expect(await submitComparison("/evaluations", { id: "same-id" })).toEqual({ id: "same-id" });
  expect(calls).toEqual([
    { url: "/evaluations/comparisons", method: "POST" },
    { url: "/evaluations/comparisons/same-id", method: "GET" },
  ]);
});

test("only a confirmed missing comparison unlocks the submitted draft", async () => {
  responses(failure(), Response.json({ error: "Comparison not found" }, { status: 404 }));
  await expect(submitComparison("/evaluations", { id: "same-id" })).rejects.toBeInstanceOf(
    UnsavedComparisonError,
  );
});

test("an unavailable lookup keeps submission uncertain", async () => {
  responses(failure(), Response.json({}, { status: 503 }));
  let caught: unknown;
  try {
    await submitComparison("/evaluations", { id: "same-id" });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).not.toBeInstanceOf(UnsavedComparisonError);
});
