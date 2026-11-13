import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HarnessOptionValue } from "../../../../src/contracts/harness-options";
import { HarnessOptionFields } from "./HarnessOptionFields";
import { ToolPicker } from "./ToolPicker";

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
