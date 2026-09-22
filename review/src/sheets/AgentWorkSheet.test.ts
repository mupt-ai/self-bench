import { expect, test } from "bun:test";
import { sheetBody } from "../components/viewer-ui";

test("keeps agent round rows compact and responsive", () => {
  const listClass = `${sheetBody} !gap-2`;
  const roundClass = "group/part border border-border bg-background open:bg-card";
  const summaryClass =
    "grid min-h-10 cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand [&::-webkit-details-marker]:hidden sm:px-4";

  expect(listClass).toContain("!gap-2");
  expect(roundClass).not.toContain("mt-");
  expect(summaryClass).toContain("min-h-10");
  expect(summaryClass).toContain("py-2");
  expect(summaryClass).toContain("focus-visible:outline-brand");
  expect(summaryClass).not.toContain("grid-cols-[1fr_auto_1fr]");
});
