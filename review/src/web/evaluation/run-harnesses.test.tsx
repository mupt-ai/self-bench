import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { catalog } from "../../../../src/evaluation/catalog";
import type { EnvironmentItem } from "../environments/environment-api";
import type { SavedHarness } from "../harnesses/harness-api";
import type { RunDraft } from "./RunExecution";
import { RunHarnessesPanel } from "./RunHarnessesPanel";
import { type HarnessChoices, harnessesProblem, subagentCredential } from "./run-harnesses";

const key = (id: string, kind: CredentialInfo["kind"]): CredentialInfo => ({
  id,
  name: id,
  kind,
  auth: "api-key",
  createdAt: "",
});
const saved = (id: number, name: string, changes: Partial<SavedHarness>): SavedHarness => ({
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
  agent: "codex",
  harnessOptions: { codex: { disable_web_search: true } },
});
const environment: EnvironmentItem = {
  id: 7,
  name: "No AGENTS.md",
  script: "rm -f AGENTS.md",
  createdAt: "",
  tasks: { total: 4, ready: 3, checking: 0, failed: 1 },
};
const choices: HarnessChoices = {
  saved: [skills, delegating, codexOnly],
  environments: [environment],
  repo: "acme/app",
  models: catalog,
  // An Anthropic key serves Haiku to Claude Code alone; a gateway key serves it to Codex too.
  credentials: [key("anthropic", "anthropic"), key("router", "openrouter"), key("e2b", "e2b")],
};
const draft = (
  picks: Pick<RunDraft, "harnesses" | "environments" | "baseline">,
  models: RunDraft["models"] = [
    { catalogId: "gpt-6-sol", credentialId: "router", harnesses: ["codex"] },
  ],
): RunDraft => ({
  id: "draft",
  tasks: [],
  models,
  sandbox: "e2b",
  sandboxCredentialId: "e2b",
  ...picks,
});

test("a harness's subagents run on its own credential while it serves them, else the first that can", () => {
  const codex = draft({ harnesses: [2] });
  expect(subagentCredential(delegating, codex, choices)?.id).toBe("router");
  // Its own Anthropic key can't serve Codex's subagents, and is not swapped for another.
  const own = saved(2, "Haiku Subagents", {
    subagent: { catalogId: "claude-haiku-5-5", prompt: "", credentialId: "anthropic" },
  });
  expect(subagentCredential(own, codex, choices)).toBeUndefined();
  expect(harnessesProblem(codex, { ...choices, saved: [own] })).toBe(
    "Haiku Subagents's subagent credential can't serve its model beside the picked models. Change it under Harnesses.",
  );
  const claude = draft({ harnesses: [2] }, [
    { catalogId: "claude-opus-5-5", credentialId: "anthropic", harnesses: ["claude-code"] },
  ]);
  expect(subagentCredential(own, claude, choices)?.id).toBe("anthropic");
  const unserved = { ...choices, credentials: [key("anthropic", "anthropic")] };
  expect(harnessesProblem(codex, unserved)).toBe(
    "Haiku Subagents needs a credential that serves its subagent model.",
  );
});

test("the Run page says why picked harnesses and repo ablations cannot run", () => {
  const on = (
    harnesses: number[],
    harness: "pi" | "codex" | "claude-code" | "terminus-2",
    catalogId = "gpt-6-sol",
  ) =>
    harnessesProblem(
      draft({ harnesses }, [{ catalogId, credentialId: "router", harnesses: [harness] }]),
      choices,
    );
  expect(on([2], "pi")).toBe(
    "Haiku Subagents sets a subagent model, which only Claude Code and Codex take.",
  );
  expect(on([3], "claude-code")).toBe("Codex Search Off is for Codex, which no picked model runs.");
  expect(on([1], "terminus-2")).toContain("adds skills, which Terminus 2 can't load");
  // A row on the subagent model itself has nothing to delegate to.
  expect(on([2], "claude-code", "claude-haiku-5-5")).toBe(
    "Haiku Subagents runs subagents on a model every picked row already runs. Add another model.",
  );
  expect(on([99], "codex")).toBe("A picked harness was deleted. Unpick it.");
  expect(on([1, 3], "codex")).toBeUndefined();
  expect(harnessesProblem(draft({ environments: [8] }), choices)).toBe(
    "A picked repo ablation was deleted. Unpick it.",
  );
  // Until the repo ablations load, a picked one is not called deleted.
  expect(
    harnessesProblem(draft({ environments: [8] }), { ...choices, environments: undefined }),
  ).toBeUndefined();
  expect(harnessesProblem(draft({ baseline: false }), choices)).toBe(
    "Run the tasks as they are, or pick a harness or a repo ablation.",
  );
  // Every harness runs in every repo ablation: 4 × 4 picks is 24 pairs beside the baseline.
  expect(
    harnessesProblem(draft({ harnesses: [1, 2, 3, 4], environments: [5, 6, 7, 8] }), choices),
  ).toBe("That is 24 harness and repo ablation pairs. Pick at most 12.");
});

test("the Run page picks harnesses and repo ablations from two lists, with no credential to pick", () => {
  const render = (picks: Pick<RunDraft, "harnesses" | "environments">, given = choices) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <RunHarnessesPanel
          draft={draft(picks)}
          choices={given}
          disabled={false}
          onChange={() => {}}
        />
      </MemoryRouter>,
    );
  const html = render({ harnesses: [2], environments: [7] });
  expect(html).toContain('aria-label="Harnesses"');
  expect(html).toContain('aria-label="Repo Ablations"');
  expect(html).toContain("3 of 4 Ready");
  expect(html).toContain("subagents on Claude Haiku 5.5");
  expect(html).toContain("Baseline, Haiku Subagents, No AGENTS.md");
  expect(html).not.toContain('aria-label="Subagent Credential"');
  expect(html).toContain('href="/settings/harnesses"');
  // A benchmark or a group has no repo ablations to pick.
  const { repo: _, ...benchmark } = choices;
  const plain = render({ harnesses: [1] }, { ...benchmark, environments: [] });
  expect(plain).not.toContain('aria-label="Repo Ablations"');
});
