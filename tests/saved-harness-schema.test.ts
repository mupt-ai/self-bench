import { expect, test } from "bun:test";
import { savedHarnessSchema } from "../src/contracts/saved-harnesses.js";

const parse = (given: unknown) => savedHarnessSchema.safeParse(given);
const messages = (given: unknown) => parse(given).error?.issues.map((issue) => issue.message) ?? [];

test("a saved harness changes one agent, and only what that agent takes", () => {
  expect(
    parse({
      name: "Turns",
      agent: "claude-code",
      harnessOptions: { "claude-code": { max_turns: 30 } },
    }).success,
  ).toBe(true);
  // An agent named alone, with skills or a subagent model it takes, is a harness too.
  expect(parse({ name: "Pack", agent: "codex", skills: ["acme/skills"] }).success).toBe(true);
  // Saved before the rename, the agent was `harness`; either spelling reads the same.
  expect(parse({ name: "Pack", harness: "codex", skills: ["acme/skills"] }).data).toMatchObject({
    agent: "codex",
  });

  expect(
    messages({
      name: "Two",
      harnessOptions: { "claude-code": { max_turns: 30 }, codex: { web_search: "live" } },
    }),
  ).toContain("it changes one agent: pick one");

  expect(
    messages({
      name: "Mixed",
      agent: "codex",
      harnessOptions: { "claude-code": { max_turns: 30 } },
    }),
  ).toContain("its options are for Claude Code, not Codex");

  expect(messages({ name: "Mini", agent: "mini-swe-agent", skills: ["acme/skills"] })).toContain(
    "Mini-SWE-Agent can't load skills. Skills run on Claude Code, Codex, and Pi",
  );

  expect(
    messages({ name: "Pi", agent: "pi", subagent: { catalogId: "claude-haiku-5-5" } }),
  ).toContain("Pi takes no subagent model: only Claude Code and Codex do");
});

test("a saved harness from before it named its agent still reads, from its options", () => {
  // Older rows and API clients name only the options; the agent they set is the one they change.
  expect(
    parse({ name: "Older", skills: ["acme/skills"], harnessOptions: { pi: { version: "1" } } })
      .success,
  ).toBe(true);
  expect(
    parse({ name: "Older", skills: ["acme/skills"], harnessOptions: { codex: { version: "1" } } })
      .success,
  ).toBe(true);
});
