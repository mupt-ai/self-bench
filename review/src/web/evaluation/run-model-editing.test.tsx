import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { hasDuplicateModelSelections } from "./model-selection";
import { RunModelTable } from "./RunModelTable";

const astra: CatalogModel = {
  id: "gpt-6-astra",
  provider: "openai",
  model: "gpt-6-astra",
  label: "GPT-6 Astra",
  harnesses: ["codex", "pi"],
  source: "",
};
const custom: CatalogModel = {
  id: "custom",
  provider: "custom",
  model: "",
  label: "Custom Model",
  harnesses: ["pi"],
  source: "",
};
const credentials: CredentialInfo[] = [
  { id: "openai", kind: "openai", name: "OpenAI", auth: "api-key", createdAt: "2026-09-14" },
  { id: "custom", kind: "custom", name: "Custom", auth: "api-key", createdAt: "2026-09-14" },
];

async function withEditor(
  selections: ComparisonDraft["models"],
  verify: (browser: Window) => Promise<void>,
) {
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
  function Editor() {
    const [draft, setDraft] = useState<ComparisonDraft>({
      id: "draft",
      tasks: [],
      models: selections,
      sandbox: "e2b",
      sandboxCredentialId: "",
    });
    return (
      <>
        <RunModelTable
          models={[astra, custom]}
          credentials={credentials}
          draft={draft}
          onChange={setDraft}
        />
        <button
          type="button"
          aria-label="Run"
          disabled={hasDuplicateModelSelections([astra, custom], draft.models)}
        >
          Run
        </button>
      </>
    );
  }
  try {
    await act(async () => root.render(<Editor />));
    await verify(browser);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
}

test("same-model rows remain editable while duplicate configurations cannot run", async () => {
  await withEditor(
    [
      { catalogId: astra.id, credentialId: "openai", harnesses: ["codex"] },
      { catalogId: "", credentialId: "", harnesses: [] },
    ],
    async (browser) => {
      const model = browser.document.querySelectorAll('select[aria-label="Model"]')[1];
      if (!(model instanceof browser.HTMLSelectElement)) throw new Error("Missing model dropdown");
      await act(async () => {
        model.value = astra.id;
        model.dispatchEvent(new browser.Event("change", { bubbles: true }));
      });
      expect(model.value).toBe(astra.id);
      expect(browser.document.querySelector('[role="alert"]')?.textContent).toContain(
        "Duplicate configurations cannot run",
      );
      expect(
        browser.document.querySelector('button[aria-label="Run"]')?.hasAttribute("disabled"),
      ).toBe(true);
      const reasoning = browser.document.querySelectorAll(
        'select[aria-label="GPT-6 Astra Thinking Level"]',
      )[1];
      if (!(reasoning instanceof browser.HTMLSelectElement))
        throw new Error("Missing thinking dropdown");
      await act(async () => {
        reasoning.value = "medium";
        reasoning.dispatchEvent(new browser.Event("change", { bubbles: true }));
      });
      expect(browser.document.querySelector('[role="alert"]')).toBeNull();
      expect(
        browser.document.querySelector('button[aria-label="Run"]')?.hasAttribute("disabled"),
      ).toBe(false);
      expect(browser.document.querySelectorAll('select[aria-label="Model"]')[1]).toBe(model);
      await act(async () => {
        reasoning.value = "high";
        reasoning.dispatchEvent(new browser.Event("change", { bubbles: true }));
      });
      expect(browser.document.querySelector('[role="alert"]')).not.toBeNull();
      const harness = browser.document.querySelectorAll(
        'select[aria-label="GPT-6 Astra Harness"]',
      )[1];
      if (!(harness instanceof browser.HTMLSelectElement))
        throw new Error("Missing harness dropdown");
      await act(async () => {
        harness.value = "pi";
        harness.dispatchEvent(new browser.Event("change", { bubbles: true }));
      });
      expect(browser.document.querySelector('[role="alert"]')).toBeNull();
      expect(
        browser.document.querySelector('button[aria-label="Run"]')?.hasAttribute("disabled"),
      ).toBe(false);
    },
  );
});

test("distinct custom configurations preserve row identity when editing and removing a sibling", async () => {
  await withEditor(
    [
      { catalogId: "custom", customModel: "first", credentialId: "custom", harnesses: ["pi"] },
      { catalogId: "custom", customModel: "second", credentialId: "custom", harnesses: ["pi"] },
    ],
    async (browser) => {
      const models = browser.document.querySelectorAll('input[aria-label="Custom Model ID"]');
      const second = models[1];
      if (!(second instanceof browser.HTMLInputElement))
        throw new Error("Missing second custom model");
      expect(browser.document.querySelector('[role="alert"]')).toBeNull();
      const credential = browser.document.querySelectorAll(
        'select[aria-label="Custom Model Credential"]',
      )[1];
      if (!(credential instanceof browser.HTMLSelectElement))
        throw new Error("Missing credential dropdown");
      await act(async () => {
        credential.value = "custom";
        credential.dispatchEvent(new browser.Event("change", { bubbles: true }));
      });
      expect(browser.document.querySelectorAll('input[aria-label="Custom Model ID"]')[1]).toBe(
        second,
      );
      const remove = browser.document.querySelector('button[aria-label="Remove Custom Model"]');
      if (!(remove instanceof browser.HTMLButtonElement)) throw new Error("Missing remove button");
      await act(async () => remove.click());
      expect(browser.document.querySelectorAll('input[aria-label="Custom Model ID"]')).toHaveLength(
        1,
      );
      expect(browser.document.querySelector('input[aria-label="Custom Model ID"]')).toBe(second);
      expect(second.value).toBe("second");
    },
  );
});
