import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CredentialActions } from "./CredentialActions";

let browser: Window;
let root: Root;
let restoreGlobals: () => void;

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
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(<CredentialActions name="Team Key" onReplace={() => {}} onDelete={() => {}} />),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  restoreGlobals();
  await browser.happyDOM.close();
});

test("pressing the actions button opens the credential menu", async () => {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[aria-label="Actions for Team Key"]',
  );
  if (!trigger) throw new Error("Missing actions button");
  expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
  await act(async () => {
    trigger.dispatchEvent(
      new browser.PointerEvent("pointerdown", { bubbles: true, button: 0 }) as unknown as Event,
    );
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
});
