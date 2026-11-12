import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { catalog } from "../../../../src/evaluation/catalog";
import type { SavedCondition } from "../conditions/condition-api";
import type { EnvironmentItem } from "../environments/environment-api";
import { RunConditionsPanel } from "./RunConditionsPanel";
import type { RunDraft } from "./RunExecution";
import { type ConditionChoices, conditionsProblem, submittedConditions } from "./run-conditions";

const key = (id: string, kind: CredentialInfo["kind"]): CredentialInfo => ({
  id,
  name: id,
  kind,
  auth: "api-key",
  createdAt: "",
});
const saved = (id: number, name: string, changes: Partial<SavedCondition>): SavedCondition => ({
  id,
  name,
  skills: [],
  createdAt: "",
  updatedAt: "",
  ...changes,
});
const skills = saved(1, "With Skills", { skills: ["https://github.com/acme/skills"] });
const delegating = saved(2, "Haiku Subagents", {
  subagent: { catalogId: "claude-haiku-5-5", prompt: "Delegate the tests." },
});
const codexOnly = saved(3, "Codex Search Off", {
  harnessOptions: { codex: { disable_web_search: true } },
});
const environment: EnvironmentItem = {
  id: 7,
  name: "No AGENTS.md",
  script: "rm -f AGENTS.md",
  createdAt: "",
  tasks: { total: 4, ready: 3, checking: 0, failed: 1 },
};
const choices: ConditionChoices = {
  saved: [skills, delegating, codexOnly],
  environments: [environment],
  models: catalog,
  // An Anthropic key serves Haiku to Claude Code alone; a gateway key serves it to Codex too.
  credentials: [key("anthropic", "anthropic"), key("router", "openrouter"), key("e2b", "e2b")],
};
const draft = (
  conditions: RunDraft["conditions"],
  models: RunDraft["models"] = [
    { catalogId: "gpt-6-sol", credentialId: "router", harnesses: ["codex"] },
  ],
): RunDraft => ({
  id: "draft",
  tasks: [],
  models,
  sandbox: "e2b",
  sandboxCredentialId: "e2b",
  conditions,
});

test("a condition's subagents run on the credential picked while it can serve them, else the first that can", () => {
  const unpicked = draft([{ saved: 2, environment: 7 }, { saved: 1 }, { environment: 7 }]);
  expect(conditionsProblem(unpicked, choices)).toBeUndefined();
  expect(submittedConditions(unpicked, choices).conditions).toEqual([
    { saved: 2, environment: 7, subagentCredentialId: "router" },
    { saved: 1 },
    { environment: 7 },
  ]);
  // The Anthropic key cannot serve Codex's subagents, so the row's pick gives way to the router.
  const stale = draft([{ saved: 2, subagentCredentialId: "anthropic" }]);
  expect(submittedConditions(stale, choices).conditions).toEqual([
    { saved: 2, subagentCredentialId: "router" },
  ]);
  const claude = draft(
    [{ saved: 2, subagentCredentialId: "anthropic" }],
    [{ catalogId: "claude-opus-5-5", credentialId: "anthropic", harnesses: ["claude-code"] }],
  );
  expect(submittedConditions(claude, choices).conditions).toEqual([
    { saved: 2, subagentCredentialId: "anthropic" },
  ]);
  const unserved = { ...choices, credentials: [key("anthropic", "anthropic")] };
  expect(conditionsProblem(stale, unserved)).toBe(
    "Haiku Subagents needs a credential that serves its subagent model.",
  );
});

test("the Run page says why a picked condition cannot run on the picked models", () => {
  const on = (
    conditions: RunDraft["conditions"],
    harness: "pi" | "codex" | "claude-code" | "terminus-2",
    catalogId = "gpt-6-sol",
  ) =>
    conditionsProblem(
      draft(conditions, [{ catalogId, credentialId: "router", harnesses: [harness] }]),
      choices,
    );
  expect(on([{ saved: 2 }], "pi")).toBe(
    "Haiku Subagents sets a subagent model, which only Claude Code and Codex take.",
  );
  expect(on([{ saved: 3 }], "claude-code")).toBe(
    "Codex Search Off sets harness options for a harness no picked model runs.",
  );
  expect(on([{ saved: 1 }], "terminus-2")).toContain("adds skills, which Terminus 2 can't load");
  // A row on the subagent model itself has nothing to delegate to.
  expect(on([{ saved: 2 }], "claude-code", "claude-haiku-5-5")).toBe(
    "Haiku Subagents runs subagents on a model every picked row already runs. Add another model.",
  );
  expect(on([{ saved: 1 }, { saved: 1 }], "codex")).toBe("Pick each condition once.");
  expect(on([{}], "codex")).toBe(
    "Pick a condition or an environment for each row, or remove the row.",
  );
  expect(on([{ saved: 99 }], "codex")).toBe("A picked condition was deleted. Pick another.");
  expect(conditionsProblem({ ...draft([]), baseline: false }, choices)).toBe(
    "Run the baseline or add a condition.",
  );
});

test("each condition row picks a saved condition and an environment, and a credential only for subagents", () => {
  const render = (conditions: RunDraft["conditions"], given = choices) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <RunConditionsPanel
          draft={draft(conditions)}
          choices={given}
          disabled={false}
          onChange={() => {}}
        />
      </MemoryRouter>,
    );
  const html = render([{ saved: 2, environment: 7 }]);
  expect(html).toContain('aria-label="Haiku Subagents · No AGENTS.md"');
  expect(html).toContain("No AGENTS.md (3 of 4 Ready)");
  expect(html).toContain('aria-label="Subagent Credential"');
  expect(html).toContain("subagents on Claude Haiku 5.5");
  expect(html).toContain('href="/settings/conditions"');
  const plain = render([{ saved: 1 }], { ...choices, environments: [] });
  expect(plain).not.toContain('aria-label="Subagent Credential"');
  // A benchmark or a group has no environments to pick.
  expect(plain).not.toContain('aria-label="Repo Ablation"');
});
