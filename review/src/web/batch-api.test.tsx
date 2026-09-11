import { expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BatchRequestError, batchIsTerminal, startBatch, validCandidateCounts } from "./batch-api";
import { GenerateBatch } from "./GenerateBatch";

test("batch form count validation and terminal states", () => {
  expect(validCandidateCounts({ easy: 1, medium: 2, hard: 3 })).toBe(true);
  for (const easy of [-1, 0.2, Number.NaN, Infinity, 10001])
    expect(validCandidateCounts({ easy, medium: 0, hard: 0 })).toBe(false);
  expect(validCandidateCounts({ easy: 0, medium: 0, hard: 0 })).toBe(false);
  for (const phase of ["complete", "blocked", "failed", "cancelled"])
    expect(batchIsTerminal(phase)).toBe(true);
  expect(batchIsTerminal("discovering")).toBe(false);
});
test("renders minimal batch trigger without starting generation", () => {
  const html = renderToStaticMarkup(
    <GenerateBatch repoId={{ org: "team", fullName: "owner/repo" }} />,
  );
  expect(html).toContain("Generate Batch");
  expect(html).not.toContain("dialog");
});

test("unconfirmed batch starts retain the run ID for navigation without resubmitting", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json(
      { runId: "batch-unconfirmed", error: "Start could not be confirmed." },
      { status: 503 },
    ),
  );
  try {
    await startBatch(
      { org: "team", fullName: "owner/repo" },
      { easy: 1, medium: 0, hard: 0 },
      {
        authorModel: "gpt-5.6-sol",
        verifierModel: "gpt-5.6-sol",
        reasoning: "high",
        sandbox: "docker",
        modelCredentialId: "00000000-0000-4000-8000-000000000001",
      },
    ).then(
      () => {
        throw new Error("Expected failure");
      },
      (error) => {
        expect(error).toBeInstanceOf(BatchRequestError);
        expect(error.runId).toBe("batch-unconfirmed");
        expect(error.message).toBe("Start could not be confirmed.");
      },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    fetch.mockRestore();
  }
});
