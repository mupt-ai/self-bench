import { expect, test } from "bun:test";
import { catalog } from "../../../../src/evaluation/catalog";
import type { RunDraft } from "./RunExecution";
import {
  codexOnly,
  delegating,
  environment,
  key,
  type Row,
  row,
  saved,
  skills,
} from "./run-harness-fixture";
import { type HarnessChoices, harnessesProblem, subagentCredential } from "./run-harnesses";

const choices: HarnessChoices = {
  saved: [skills, delegating, codexOnly],
  environments: [environment],
  models: catalog,
  // An Anthropic key serves Haiku to Claude Code alone; a gateway key serves it to Codex too.
  credentials: [key("anthropic", "anthropic"), key("router", "openrouter"), key("e2b", "e2b")],
};
const draft = (
  models: Row[],
  picks: Pick<RunDraft, "environments" | "baseline"> = {},
): RunDraft => ({
  id: "draft",
  tasks: [],
  models,
  sandbox: "e2b",
  sandboxCredentialId: "e2b",
  ...picks,
});

test("a harness's subagents run on its own credential while it serves the row, else the first that can", () => {
  const codex = row("codex", { harness: 2 });
  expect(subagentCredential(delegating, codex, choices)?.id).toBe("router");
  // Its own Anthropic key can't serve Codex's subagents, and is not swapped for another.
  const own = saved(2, "Haiku Subagents", {
    subagent: { catalogId: "claude-haiku-5-5", prompt: "", credentialId: "anthropic" },
  });
  expect(subagentCredential(own, codex, choices)).toBeUndefined();
  expect(harnessesProblem(draft([codex]), { ...choices, saved: [own] })).toBe(
    "Haiku Subagents's subagent credential can't serve its model beside this row's. Change it under Harnesses.",
  );
  const claude = row("claude-code", {
    catalogId: "claude-opus-5-5",
    credentialId: "anthropic",
    harness: 2,
  });
  expect(subagentCredential(own, claude, choices)?.id).toBe("anthropic");
  const unserved = { ...choices, credentials: [key("anthropic", "anthropic")] };
  expect(harnessesProblem(draft([codex]), unserved)).toBe(
    "Haiku Subagents needs a credential that serves its subagent model.",
  );
});

test("the Run page says why a row's saved harness or a repo ablation cannot run", () => {
  const on = (harness: number, agent: Row["harnesses"][number], catalogId = "gpt-6-sol") =>
    harnessesProblem(draft([row(agent, { harness, catalogId })]), choices);
  expect(on(2, "pi")).toBe(
    "Haiku Subagents sets a subagent model, which only Claude Code and Codex take.",
  );
  expect(on(3, "claude-code")).toBe("Codex Search Off is for Codex, not Claude Code.");
  expect(on(1, "terminus-2")).toContain("adds skills, which Terminus 2 can't load");
  // A row on the subagent model itself has nothing to delegate to.
  expect(on(2, "claude-code", "claude-haiku-5-5")).toBe(
    "Haiku Subagents runs subagents on this row's own model. Pick another harness or model.",
  );
  expect(on(99, "codex")).toBe("A row's saved harness was deleted. Pick another harness for it.");
  // Until the saved harnesses load, a row's is not called deleted.
  expect(
    harnessesProblem(draft([row("codex", { harness: 99 })]), { ...choices, saved: undefined }),
  ).toBeUndefined();
  expect(on(1, "codex")).toBeUndefined();
  expect(on(3, "codex")).toBeUndefined();
  // Each row is checked against its own harness: a plain row beside a saved one is fine.
  expect(
    harnessesProblem(draft([row("pi"), row("codex", { harness: 2 })]), choices),
  ).toBeUndefined();
  expect(harnessesProblem(draft([row("codex")], { environments: [8] }), choices)).toBe(
    "A picked repo ablation was deleted. Unpick it.",
  );
  // Until the repo ablations load, a picked one is not called deleted.
  expect(
    harnessesProblem(draft([row("codex")], { environments: [8] }), {
      ...choices,
      environments: undefined,
    }),
  ).toBeUndefined();
  expect(harnessesProblem(draft([row("codex")], { baseline: false }), choices)).toBe(
    "Pick a repo ablation, or include the original tasks.",
  );
  expect(
    harnessesProblem(draft([row("codex")], { baseline: false, environments: [7] }), choices),
  ).toBeUndefined();
});
