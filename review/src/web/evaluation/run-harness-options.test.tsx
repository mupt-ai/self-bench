import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunDraft } from "./RunExecution";
import { RunHarnessOptions } from "./RunHarnessOptions";
import { conditionsProblem, submittedConditions } from "./run-conditions";

type Condition = NonNullable<RunDraft["conditions"]>[number];

const draft = (condition: Condition, harnesses: RunDraft["models"][number]["harnesses"]) =>
  ({
    id: "draft",
    tasks: [],
    models: [{ catalogId: "gpt-6-sol", credentialId: "router", harnesses }],
    sandbox: "e2b",
    sandboxCredentialId: "",
    conditions: [condition],
  }) as RunDraft;

test("typed option text is sent as each option's value, for the harnesses the run picks", () => {
  const condition: Condition = {
    name: "Tuned",
    skills: [],
    harnessOptions: {
      "claude-code": {
        max_turns: "30",
        disable_web_search: "true",
        config: '{ "env": { "A": "1" } }',
        append_system_prompt: "Run the tests first.",
      },
      codex: { web_search: "disabled" },
    },
  };
  const picked = draft(condition, ["claude-code"]);
  expect(conditionsProblem(picked)).toBeUndefined();
  expect(submittedConditions(picked).conditions).toEqual([
    {
      name: "Tuned",
      skills: [],
      // Codex isn't picked, so its options stay in the draft but aren't sent.
      harnessOptions: {
        "claude-code": {
          max_turns: 30,
          disable_web_search: true,
          config: { env: { A: "1" } },
          append_system_prompt: "Run the tests first.",
        },
      },
    },
  ]);
  const broken = (options: Record<string, string>) =>
    conditionsProblem(
      draft({ name: "Tuned", skills: [], harnessOptions: { "claude-code": options } }, [
        "claude-code",
      ]),
    );
  expect(broken({ config: "{ env" })).toBe("Claude Code Native Config isn't valid JSON.");
  expect(broken({ max_turns: "" })).toBe("Claude Code Max Turns is a whole number.");
  expect(broken({ config: '{"model": "opus"}' })).toContain("can't set model");
  // Options for a harness the run doesn't pick change nothing, so the condition needs something else.
  expect(conditionsProblem(draft(condition, ["pi"]))).toBe(
    "Tuned needs an environment, a skill, instructions, or a harness option.",
  );
});

test("the harness options editor asks for a harness first, then offers that harness's options", () => {
  const render = (harnesses: Parameters<typeof RunHarnessOptions>[0]["harnesses"]) =>
    renderToStaticMarkup(
      <RunHarnessOptions
        condition={{
          name: "Tuned",
          skills: [],
          harnessOptions: { "claude-code": { append_system_prompt: "Run the tests first." } },
        }}
        harnesses={harnesses}
        idPrefix="condition-0"
        onChange={() => {}}
      />,
    );
  expect(render([])).toContain("Pick a model with a harness to set its options.");
  const html = render(["claude-code"]);
  expect(html).toContain("Append System Prompt");
  expect(html).toContain('aria-label="Add Claude Code Option"');
  expect(html).toContain("Run the tests first.");
  // The option set is not offered again.
  expect(html).not.toContain('<option value="append_system_prompt">');
});

test("picking an option adds it with a value that changes something, and removing it drops it", async () => {
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
  let seen: Condition["harnessOptions"];
  function Editor() {
    const [condition, setCondition] = useState<Condition>({ name: "Tuned", skills: [] });
    seen = condition.harnessOptions;
    return (
      <RunHarnessOptions
        condition={condition}
        harnesses={["claude-code", "codex"]}
        idPrefix="condition-0"
        onChange={(harnessOptions) => setCondition({ ...condition, harnessOptions })}
      />
    );
  }
  try {
    await act(async () => root.render(<Editor />));
    const add = browser.document.querySelector('select[aria-label="Add Codex Option"]');
    if (!(add instanceof browser.HTMLSelectElement)) throw new Error("Missing option picker");
    await act(async () => {
      add.value = "disable_web_search";
      add.dispatchEvent(new browser.Event("change", { bubbles: true }));
    });
    expect(seen).toEqual({ codex: { disable_web_search: "true" } });
    const box = browser.document.querySelector('input[aria-label="Codex Disable Web Search"]');
    expect(box instanceof browser.HTMLInputElement && box.checked).toBe(true);
    const remove = browser.document.querySelector(
      'button[aria-label="Remove Codex Disable Web Search"]',
    );
    if (!(remove instanceof browser.HTMLButtonElement)) throw new Error("Missing remove button");
    await act(async () => remove.click());
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
