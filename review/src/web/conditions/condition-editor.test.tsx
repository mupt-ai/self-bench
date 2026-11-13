import { expect, test } from "bun:test";
import { DEFAULT_SUBAGENT_PROMPT, MAX_SKILLS } from "../../../../src/contracts/conditions";
import {
  blankCondition,
  type ConditionDraft,
  conditionProblem,
  draftOf,
  instructionsWhere,
  type OptionsDraft,
  subagentOn,
  submittedCondition,
  systemOptionSet,
  withHarness,
} from "./condition-draft";
import { conditionSummary } from "./condition-summary";

const tuned = (harnessOptions: OptionsDraft = {}): ConditionDraft => ({
  ...blankCondition(),
  name: " Tuned ",
  harness: "claude-code",
  harnessOptions,
});

test("a condition is saved with its harness, typed option values, trimmed text, and no blank skills", () => {
  const draft: ConditionDraft = {
    ...tuned({
      "claude-code": {
        max_turns: "30",
        disable_web_search: "true",
        config: '{ "env": { "A": "1" } }',
        append_system_prompt: "Run the tests first.",
      },
      // Typed under another harness before switching: kept in the draft, never saved.
      codex: { web_search: "live" },
    }),
    skills: ["vercel/next.js@canary", "  "],
    instructions: "  Read the docs.  ",
  };
  expect(conditionProblem(draft)).toBeUndefined();
  const submitted = submittedCondition(draft);
  expect(submitted).toEqual({
    name: "Tuned",
    harness: "claude-code",
    skills: ["vercel/next.js@canary"],
    instructions: "Read the docs.",
    harnessOptions: {
      "claude-code": {
        max_turns: 30,
        disable_web_search: true,
        config: { env: { A: "1" } },
        append_system_prompt: "Run the tests first.",
      },
    },
  });
  // Reopened for editing, a saved condition's typed values save as the same condition.
  const saved = { ...submitted, id: 1, createdAt: "", updatedAt: "" };
  expect(submittedCondition(draftOf(saved))).toEqual(submitted);
  // One saved before conditions named their harness takes it from its options.
  const { harness: _, ...older } = saved;
  expect(draftOf(older).harness).toBe("claude-code");
  // With task instructions and a system prompt both set, the system prompt stays an option of its
  // own, so Instructions can't also go there and overwrite it.
  const both = draftOf(saved);
  expect(systemOptionSet(both)).toBe(true);
  expect(instructionsWhere({ ...both, instructionsWhere: "system" })).toBe("task");
  // Codex's native config, as typed on the Options page, guards the same way.
  const typed = (config: string): ConditionDraft => ({
    ...blankCondition(),
    harness: "codex",
    harnessOptions: { codex: { config } },
  });
  expect(systemOptionSet(typed('{"developer_instructions": "Be brief."}'))).toBe(true);
  expect(systemOptionSet(typed('{"sandbox_mode": "workspace-write"}'))).toBe(false);
});

test("a condition says what stops it from being saved", () => {
  const broken = (options: Record<string, string>) =>
    conditionProblem(tuned({ "claude-code": options }));
  expect(broken({ config: "{ env" })).toBe("Claude Code Native Config isn't valid JSON.");
  expect(broken({ max_turns: "" })).toBe("Claude Code Max Turns is a whole number.");
  expect(broken({ config: '{"model": "opus"}' })).toContain("can't set model");
  expect(conditionProblem(blankCondition())).toBe("Name the condition.");
  expect(conditionProblem(tuned())).toBe(
    "Add a skill, instructions, a harness option, or a subagent model.",
  );
  expect(conditionProblem({ ...tuned(), skills: ["not a repo"] })).toBe(
    "Write each skill as a GitHub org/repo, org/repo@ref, or URL.",
  );
  const many = Array.from({ length: MAX_SKILLS + 1 }, (_, at) => `acme/skills-${at}`);
  expect(conditionProblem({ ...tuned(), skills: many })).toBe(
    `A condition can add at most ${MAX_SKILLS} skills.`,
  );
  // Skills and a subagent model belong to a harness; extra instructions alone need none.
  const { harness: _, ...unpicked } = tuned();
  expect(conditionProblem({ ...unpicked, skills: ["acme/skills"] })).toBe(
    "Pick a harness for its skills, options, or subagent model.",
  );
  expect(conditionProblem({ ...unpicked, instructions: "Read the docs." })).toBeUndefined();
});

test("picking a harness drops the skills and subagent model it can't take, and keeps typed options", () => {
  const draft: ConditionDraft = {
    ...tuned({ "claude-code": { max_turns: "30" } }),
    skills: ["acme/skills"],
    subagent: subagentOn("claude-haiku-5-5"),
  };
  const mini = withHarness(draft, "mini-swe-agent");
  expect(mini.harness).toBe("mini-swe-agent");
  expect(mini.skills).toEqual([]);
  expect(mini.subagent).toBeUndefined();
  // Pi loads skills but takes no subagent model.
  const pi = withHarness(draft, "pi");
  expect(pi.skills).toEqual(["acme/skills"]);
  expect(pi.subagent).toBeUndefined();
  // Back to Claude Code, its typed options are still there.
  expect(withHarness(mini, "claude-code").harnessOptions["claude-code"]).toEqual({
    max_turns: "30",
  });
});

test("a subagent model alone makes a condition; its delegation prompt is the instructions", () => {
  const delegating = { ...tuned(), subagent: subagentOn("claude-haiku-5-5") };
  expect(conditionProblem(delegating)).toBeUndefined();
  // The editor tells the harness to delegate through Instructions, so the subagent carries none.
  expect(submittedCondition(delegating).subagent).toEqual({
    catalogId: "claude-haiku-5-5",
    prompt: "",
  });
  // One saved with its own delegation prompt reopens with it as the system prompt instructions.
  const older = draftOf({
    name: "Older",
    harness: "claude-code",
    skills: [],
    subagent: { catalogId: "claude-haiku-5-5", prompt: DEFAULT_SUBAGENT_PROMPT },
    id: 3,
    createdAt: "",
    updatedAt: "",
  });
  expect(older).toMatchObject({
    instructions: DEFAULT_SUBAGENT_PROMPT,
    instructionsWhere: "system",
    subagent: { catalogId: "claude-haiku-5-5", prompt: "" },
  });
  const saved = { ...submittedCondition(delegating), skills: ["https://github.com/a/b"] };
  const models = [{ id: "claude-haiku-5-5", label: "Claude Haiku 5.5" }];
  expect(conditionSummary(saved, models)).toEqual([
    "Claude Code",
    "1 skill",
    "subagents on Claude Haiku 5.5",
  ]);
  // A model the catalog no longer lists is named by its id.
  expect(conditionSummary(saved)).toEqual([
    "Claude Code",
    "1 skill",
    "subagents on claude-haiku-5-5",
  ]);
});

test("instructions go in the task prompt, or Claude Code's system prompt, and reopen where they went", () => {
  const system: ConditionDraft = {
    ...tuned(),
    instructions: "  Prefer small diffs.  ",
    instructionsWhere: "system",
  };
  const saved = submittedCondition(system);
  expect(saved.instructions).toBeUndefined();
  expect(saved.harnessOptions).toEqual({
    "claude-code": { append_system_prompt: "Prefer small diffs." },
  });
  const reopened = draftOf({ ...saved, id: 1, createdAt: "", updatedAt: "" });
  expect(reopened.instructionsWhere).toBe("system");
  expect(reopened.instructions).toBe("Prefer small diffs.");
  expect(reopened.harnessOptions["claude-code"]).toEqual({});
  // Codex takes them as developer_instructions in its native config, beside what else it sets.
  const codex = submittedCondition({
    ...system,
    harness: "codex",
    harnessOptions: { codex: { config: '{"approval_policy": "never"}' } },
  });
  expect(codex.instructions).toBeUndefined();
  expect(codex.harnessOptions).toEqual({
    codex: { config: { approval_policy: "never", developer_instructions: "Prefer small diffs." } },
  });
  const back = draftOf({ ...codex, id: 2, createdAt: "", updatedAt: "" });
  expect(back.instructionsWhere).toBe("system");
  expect(back.harnessOptions.codex).toEqual({ config: { approval_policy: "never" } });
  // A harness with no system prompt sends them to the task's prompt.
  const mini = submittedCondition({ ...system, harness: "mini-swe-agent" });
  expect(mini.instructions).toBe("Prefer small diffs.");
  expect(mini.harnessOptions).toBeUndefined();
});
