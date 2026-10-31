import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { catalog } from "../../../../src/evaluation/catalog";
import { RunSubagentControls } from "./RunSubagentControls";

test("subagent summary stays compact while editing, credential changes, and parent reset work", async () => {
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
  const model = catalog.find((entry) => entry.id === "gpt-6-sol");
  if (!model) throw new Error("Missing model");
  const credentials: CredentialInfo[] = ["Router A", "Router B"].map((name, index) => ({
    id: `router-${index}`,
    name,
    kind: "openrouter",
    auth: "api-key",
    createdAt: "",
  }));
  function Editor() {
    const [value, setValue] = useState<{ catalogId: string; credentialId: string } | undefined>({
      catalogId: model?.id ?? "",
      credentialId: "router-0",
    });
    return (
      <RunSubagentControls
        models={catalog}
        credentials={credentials}
        harnesses={["codex"]}
        value={value}
        onChange={setValue}
      />
    );
  }
  const button = (label: string) => {
    const element = [...browser.document.querySelectorAll("button")].find(
      (entry) => entry.getAttribute("aria-label") === label || entry.textContent === label,
    );
    if (!element) throw new Error(`Missing button: ${label}`);
    return element;
  };
  try {
    await act(async () => root.render(<Editor />));
    expect(container.textContent).toContain(model.label);
    expect(container.textContent).toContain("Router A");
    expect(container.querySelector("select")).toBeNull();
    expect(button("Edit Subagent Model").getAttribute("aria-expanded")).toBe("false");

    await act(async () => button("Edit Subagent Model").click());
    expect(button("Done").getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("does not force delegation");
    const credential = browser.document.querySelector('select[aria-label="Subagent Credential"]');
    if (!(credential instanceof browser.HTMLSelectElement)) throw new Error("Missing credential");
    await act(async () => {
      credential.value = "router-1";
      credential.dispatchEvent(new browser.Event("change", { bubbles: true }));
    });
    await act(async () => button("Done").click());
    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).toContain("Router B");
    expect(container.textContent).not.toContain("Router A");

    await act(async () => button("Edit Subagent Model").click());
    await act(async () => button("Use Parent Model").click());
    expect(container.textContent).toContain("Same as Parent");
    expect(container.querySelector("select")).toBeNull();
    await act(async () => button("Add Subagent Model").click());
    expect(button("Done").getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('select[aria-label="Subagent Credential"]')).not.toBeNull();
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
