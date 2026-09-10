import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { batchIsTerminal, validCandidateCounts } from "./batch-api";
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
