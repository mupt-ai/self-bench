import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { ModelPicker } from "./ModelPicker";

const listed = (id: string, label: string): CatalogModel => ({
  id,
  label,
  provider: "openrouter",
  model: id,
  harnesses: ["pi"],
  source: "",
});
const models = [
  listed("anthropic/claude-opus-5.5", "Claude Opus 5.5"),
  listed("moonshotai/kimi-k3", "Kimi K3"),
  listed("moonshotai/kimi-k2.5", "Kimi K2.5"),
];

let browser: Window;
let root: Root;
let container: HTMLDivElement;
let restoreGlobals: () => void;
let chosen: string[];

beforeEach(async () => {
  browser = new Window({ url: "https://selfbench.test" });
  const globals = {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  for (const [name, value] of Object.entries(globals))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  restoreGlobals = () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
  chosen = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <ModelPicker models={models} value="" onSelect={(model) => chosen.push(model.id)} />,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreGlobals();
  await browser.happyDOM.close();
});

const event = (name: string, init: object = {}) =>
  new browser.KeyboardEvent(name, { bubbles: true, ...init }) as unknown as Event;
const options = () =>
  [...container.querySelectorAll('[role="option"]')].map((option) => option.textContent);

/** React watches the focused input and compares its value on keyup; see ApiKeysPage.test.tsx. */
async function type(input: HTMLInputElement, value: string) {
  Object.assign(input, { attachEvent() {}, detachEvent() {} });
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  await act(async () => input.dispatchEvent(event("focusin")));
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(event("keyup"));
  });
}

test("one control opens a search above the models and picks from the keyboard", async () => {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
  if (!trigger) throw new Error("Missing picker");
  expect(trigger.textContent).toBe("Select Model");
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  await act(async () => trigger.click());
  expect(options()).toEqual(["Claude Opus 5.5", "Kimi K3", "Kimi K2.5"]);
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search Models"]');
  if (!search) throw new Error("Missing search");
  // The search sits at the top of the open list, not in a second control beside it.
  const listbox = container.querySelector('[role="listbox"]');
  if (!listbox) throw new Error("Missing list");
  expect(search.compareDocumentPosition(listbox) & browser.Node.DOCUMENT_POSITION_FOLLOWING).toBe(
    browser.Node.DOCUMENT_POSITION_FOLLOWING,
  );
  await type(search, "kimi");
  expect(options()).toEqual(["Kimi K3", "Kimi K2.5"]);
  await act(async () => search.dispatchEvent(event("keydown", { key: "ArrowDown" })));
  await act(async () => search.dispatchEvent(event("keydown", { key: "Enter" })));
  expect(chosen).toEqual(["moonshotai/kimi-k2.5"]);
  expect(container.querySelector('[role="listbox"]')).toBeNull();
});
