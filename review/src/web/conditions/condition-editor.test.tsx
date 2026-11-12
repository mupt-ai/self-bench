import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_SUBAGENT_PROMPT, MAX_SKILLS } from "../../../../src/contracts/conditions";
import {
  blankCondition,
  type ConditionDraft,
  conditionProblem,
  draftOf,
  type OptionsDraft,
  subagentOn,
  submittedCondition,
} from "./condition-draft";
import { conditionSummary } from "./condition-summary";
import { HarnessOptionsEditor } from "./HarnessOptionsEditor";

const tuned = (harnessOptions: OptionsDraft): ConditionDraft => ({
  ...blankCondition(),
  name: " Tuned ",
  harnessOptions,
});

test("a condition is saved with typed option values, trimmed text, and no blank skills", () => {
  const draft: ConditionDraft = {
    ...tuned({
      "claude-code": {
        max_turns: "30",
        disable_web_search: "true",
        config: '{ "env": { "A": "1" } }',
        append_system_prompt: "Run the tests first.",
      },
    }),
    skills: ["vercel/next.js@canary", "  "],
    instructions: "  Read the docs.  ",
  };
  expect(conditionProblem(draft)).toBeUndefined();
  const submitted = submittedCondition(draft);
  expect(submitted).toEqual({
    name: "Tuned",
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
});

test("a condition says what stops it from being saved", () => {
  const broken = (options: Record<string, string>) =>
    conditionProblem(tuned({ "claude-code": options }));
  expect(broken({ config: "{ env" })).toBe("Claude Code Native Config isn't valid JSON.");
  expect(broken({ max_turns: "" })).toBe("Claude Code Max Turns is a whole number.");
  expect(broken({ config: '{"model": "opus"}' })).toContain("can't set model");
  expect(conditionProblem(blankCondition())).toBe("Name the condition.");
  expect(conditionProblem(tuned({}))).toBe(
    "Add a skill, instructions, a harness option, or a subagent model.",
  );
  expect(conditionProblem({ ...tuned({}), skills: ["not a repo"] })).toBe(
    "Write each skill as a GitHub org/repo, org/repo@ref, or URL.",
  );
  const many = Array.from({ length: MAX_SKILLS + 1 }, (_, at) => `acme/skills-${at}`);
  expect(conditionProblem({ ...tuned({}), skills: many })).toBe(
    `A condition can add at most ${MAX_SKILLS} skills.`,
  );
});

test("a subagent model alone makes a condition, with the default prompt, another, or none", () => {
  const delegating = { ...tuned({}), subagent: subagentOn("claude-haiku-5-5") };
  expect(conditionProblem(delegating)).toBeUndefined();
  expect(submittedCondition(delegating).subagent).toEqual({
    catalogId: "claude-haiku-5-5",
    prompt: DEFAULT_SUBAGENT_PROMPT,
  });
  const silent = { ...delegating, subagent: subagentOn("claude-haiku-5-5", "  ") };
  expect(conditionProblem(silent)).toBeUndefined();
  expect(submittedCondition(silent).subagent?.prompt).toBe("");
  const saved = { ...submittedCondition(delegating), skills: ["https://github.com/a/b"] };
  const models = [{ id: "claude-haiku-5-5", label: "Claude Haiku 5.5" }];
  expect(conditionSummary(saved, models)).toEqual(["1 skill", "subagents on Claude Haiku 5.5"]);
  // A model the catalog no longer lists is named by its id.
  expect(conditionSummary(saved)).toEqual(["1 skill", "subagents on claude-haiku-5-5"]);
});

test("a harness is added before its options, which start on a value that changes something", async () => {
  const browser = new Window({ url: "https://selfbench.test" });
  const globals = {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let seen: OptionsDraft = {};
  function Editor() {
    const [options, setOptions] = useState<OptionsDraft>({
      "claude-code": { append_system_prompt: "Run the tests first." },
    });
    seen = options;
    return <HarnessOptionsEditor value={options} idPrefix="condition" onChange={setOptions} />;
  }
  const pick = async (label: string, value: string) => {
    const select = browser.document.querySelector(`select[aria-label="${label}"]`);
    if (!(select instanceof browser.HTMLSelectElement)) throw new Error(`Missing ${label}`);
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new browser.Event("change", { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(<Editor />));
    // A harness with an option set shows its options; the option set is not offered again.
    const claude = browser.document.querySelector('select[aria-label="Add Claude Code Option"]');
    expect(claude?.querySelector('option[value="append_system_prompt"]')).toBeNull();
    expect(browser.document.querySelector('select[aria-label="Add Codex Option"]')).toBeNull();
    await pick("Add Harness", "codex");
    await pick("Add Codex Option", "disable_web_search");
    expect(seen.codex).toEqual({ disable_web_search: "true" });
    const box = browser.document.querySelector('input[aria-label="Codex Disable Web Search"]');
    expect(box instanceof browser.HTMLInputElement && box.checked).toBe(true);
    const remove = browser.document.querySelector(
      'button[aria-label="Remove Codex Disable Web Search"]',
    );
    if (!(remove instanceof browser.HTMLButtonElement)) throw new Error("Missing remove button");
    await act(async () => remove.click());
    expect(seen).toEqual({ "claude-code": { append_system_prompt: "Run the tests first." } });
  } finally {
    await act(async () => root.unmount());
    container.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
});
