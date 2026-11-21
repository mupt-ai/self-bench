import { expect, test } from "bun:test";
import { helpText } from "../src/api/cli/help.js";

test("the top level lists one line per command, not every verb", () => {
  const text = helpText([]);
  expect(text).toContain("  task  Create, review, fix, and inspect tasks");
  expect(text).not.toContain("task approve");
});

test("nested commands and their older names reach the same help", () => {
  expect(helpText(["batch", "create"])).toBe(helpText(["repo", "batch", "create"]));
  expect(helpText(["repo", "batch", "create"])).toContain(
    "self-bench repo batch create --repo OWNER/NAME",
  );
  expect(helpText(["feedback"])).toContain("self-bench task feedback TASK_URL");
});
