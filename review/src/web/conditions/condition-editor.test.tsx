import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_SUBAGENT_PROMPT, MAX_SKILLS } from "../../../../src/contracts/conditions";
import type { HarnessOptionValue } from "../../../../src/contracts/harness-options";
import {
  blankCondition,
  type ConditionDraft,
  conditionProblem,
  draftOf,
  type OptionsDraft,
  subagentOn,
  submittedCondition,
  withHarness,
} from "./condition-draft";
import { conditionSummary } from "./condition-summary";
import { HarnessOptionFields } from "./HarnessOptionFields";
import { ToolPicker } from "./ToolPicker";

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

test("a subagent model alone makes a condition, with the default prompt, another, or none", () => {
  const delegating = { ...tuned(), subagent: subagentOn("claude-haiku-5-5") };
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
  // A harness without a system prompt option sends them to the task's prompt.
  const codex = submittedCondition({ ...system, harness: "codex" });
  expect(codex.instructions).toBe("Prefer small diffs.");
  expect(codex.harnessOptions).toBeUndefined();
});

test("every option a harness takes is a field, left at Harbor's default until set", async () => {
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
  let seen: Record<string, HarnessOptionValue> = {};
  function Fields() {
    const [options, setOptions] = useState<Record<string, HarnessOptionValue>>({});
    seen = options;
    return (
      <HarnessOptionFields
        harness="codex"
        options={options}
        idPrefix="condition-codex"
        disabled={false}
        onSet={(name, value) => {
          const { [name]: _, ...rest } = options;
          setOptions(value === undefined ? rest : { ...rest, [name]: value });
        }}
      />
    );
  }
  const select = (label: string) => {
    const found = browser.document.querySelector(`select[aria-label="${label}"]`);
    if (!(found instanceof browser.HTMLSelectElement)) throw new Error(`Missing ${label}`);
    return found;
  };
  const pick = async (label: string, value: string) => {
    const found = select(label);
    await act(async () => {
      found.value = value;
      found.dispatchEvent(new browser.Event("change", { bubbles: true }));
    });
  };
  try {
    await act(async () => root.render(<Fields />));
    // Nothing to add or remove: each of Codex's options is already a field, at its default.
    expect(select("Disable Web Search").value).toBe("");
    expect(select("Web Search").value).toBe("");
    expect(browser.document.querySelector('textarea[aria-label="Native Config"]')).not.toBeNull();
    expect(browser.document.querySelector('button[aria-label^="Remove"]')).toBeNull();
    expect(browser.document.querySelector('select[aria-label^="Add"]')).toBeNull();
    await pick("Disable Web Search", "true");
    expect(seen).toEqual({ disable_web_search: "true" });
    // Claude Code's system prompt is the Instructions field's, so its options don't list it.
    await act(async () =>
      root.render(
        <HarnessOptionFields
          harness="claude-code"
          options={{}}
          idPrefix="condition-claude-code"
          disabled={false}
          onSet={() => undefined}
        />,
      ),
    );
    expect(browser.document.querySelector('[aria-label="Append System Prompt"]')).toBeNull();
    expect(browser.document.querySelector('fieldset[aria-label="Allowed Tools"]')).not.toBeNull();
    await act(async () => root.render(<Fields />));
    // Back to Harbor's default, the option is no longer set at all.
    await pick("Disable Web Search", "");
    expect(seen).toEqual({});
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

test("tools are picked as chips beside a box for any others, and saved as Harbor's comma-separated list", async () => {
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
  let seen = "";
  function Picker() {
    const [value, setValue] = useState("Bash,mcp__github");
    seen = value;
    return (
      <ToolPicker
        id="tools"
        label="Allowed Tools"
        harness="claude-code"
        value={value}
        onChange={setValue}
      />
    );
  }
  const chip = (name: string) => {
    const found = [...browser.document.querySelectorAll("button")].find(
      (button) => button.textContent === name,
    );
    if (!found) throw new Error(`Missing ${name}`);
    return found;
  };
  try {
    await act(async () => root.render(<Picker />));
    expect(chip("Bash").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Read").getAttribute("aria-pressed")).toBe("false");
    const other = browser.document.querySelector('input[aria-label="Other Allowed Tools"]');
    expect(other instanceof browser.HTMLInputElement && other.value).toBe("mcp__github");
    await act(async () => chip("Read").click());
    expect(seen).toBe("Bash,mcp__github,Read");
    await act(async () => chip("Bash").click());
    expect(seen).toBe("mcp__github,Read");
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
