import { expect, test } from "bun:test";
import { savedConditionSchema } from "../src/contracts/conditions.js";

const parse = (given: unknown) => savedConditionSchema.safeParse(given);
const messages = (given: unknown) => parse(given).error?.issues.map((issue) => issue.message) ?? [];

test("a saved condition changes one harness, and only what that harness takes", () => {
  expect(
    parse({
      name: "Turns",
      harness: "claude-code",
      harnessOptions: { "claude-code": { max_turns: 30 } },
    }).success,
  ).toBe(true);
  // A harness named alone, with skills or a subagent model it takes, is a condition too.
  expect(parse({ name: "Pack", harness: "codex", skills: ["acme/skills"] }).success).toBe(true);

  expect(
    messages({
      name: "Two",
      harnessOptions: { "claude-code": { max_turns: 30 }, codex: { web_search: "live" } },
    }),
  ).toContain("a condition changes one harness: pick one");

  expect(
    messages({
      name: "Mixed",
      harness: "codex",
      harnessOptions: { "claude-code": { max_turns: 30 } },
    }),
  ).toContain("its harness options are for Claude Code, not Codex");

  expect(messages({ name: "Mini", harness: "mini-swe-agent", skills: ["acme/skills"] })).toContain(
    "Mini-SWE-Agent can't load skills. Skills run on Claude Code, Codex, and Pi",
  );

  expect(
    messages({ name: "Pi", harness: "pi", subagent: { catalogId: "claude-haiku-5-5" } }),
  ).toContain("Pi takes no subagent model: only Claude Code and Codex do");
});

test("a saved condition from before it named its harness still reads, from its options", () => {
  // Older rows and API clients name only the options; the harness they set is the one they change.
  expect(
    parse({ name: "Older", skills: ["acme/skills"], harnessOptions: { pi: { version: "1" } } })
      .success,
  ).toBe(true);
  expect(
    parse({ name: "Older", skills: ["acme/skills"], harnessOptions: { codex: { version: "1" } } })
      .success,
  ).toBe(true);
});
