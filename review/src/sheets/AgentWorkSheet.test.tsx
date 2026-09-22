import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./AgentWorkSheet.tsx", import.meta.url), "utf8");

test("keeps the round title and untruncated status on one compact row", () => {
  expect(source).toContain("!gap-2");
  expect(source).not.toContain("[&+&]:mt-3");
  expect(source).toContain("flex min-h-10 cursor-pointer");
  expect(source).toContain("shrink-0 whitespace-nowrap font-mono text-xs");
  expect(source).not.toContain("row-span-2");
  expect(source).not.toContain("max-w-[45%] truncate text-right");
});
