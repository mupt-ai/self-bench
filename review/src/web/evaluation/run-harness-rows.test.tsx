import { expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { catalog } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { hasDuplicateModelSelections } from "./model-selection";
import { RunModelTable } from "./RunModelTable";
import { codexOnly, delegating, inBrowser, key, row, skills } from "./run-harness-fixture";

const sol = catalog.find((model) => model.id === "gpt-6-sol");
if (!sol) throw new Error("Missing catalog model");
const credentials = [key("router", "openrouter")];
const drafted = (models: ComparisonDraft["models"]): ComparisonDraft => ({
  id: "draft",
  models,
  sandbox: "e2b",
  sandboxCredentialId: "",
});

test("a row's Harness offers the saved harnesses it can run, and picking one sets the row's", async () => {
  let latest: ComparisonDraft["models"] = [];
  function Table() {
    const [value, setValue] = useState(drafted([row("pi")]));
    latest = value.models;
    return (
      <RunModelTable
        models={[sol as NonNullable<typeof sol>]}
        credentials={credentials}
        draft={value}
        saved={[skills, delegating, codexOnly]}
        onChange={setValue}
      />
    );
  }
  await inBrowser(async (browser, container) => {
    const root = createRoot(container);
    await act(async () => root.render(<Table />));
    const trigger = () => {
      const found = container.querySelector<HTMLButtonElement>(
        'button[aria-label="GPT-6 Sol Harness"]',
      );
      if (!found) throw new Error("Missing Harness picker");
      return found;
    };
    const listed = () =>
      [...browser.document.querySelectorAll('[role="option"]')] as unknown as HTMLElement[];
    /** Opens the picker and reads its saved harnesses, each with what it changes. */
    const open = async () => {
      await act(async () => trigger().click());
      return listed()
        .map((option) => [...option.querySelectorAll("span span")].map((part) => part.textContent))
        .filter((parts) => parts.length === 2)
        .map((parts) => parts.join(": "));
    };
    const pick = async (label: string) => {
      const option = listed().find((entry) => entry.textContent?.startsWith(label));
      if (!option) throw new Error(`Missing ${label}`);
      await act(async () => option.click());
    };
    // On Pi: skills load there, Codex's own harness is offered on Codex, and Pi takes no subagents.
    expect(await open()).toEqual([
      "With Skills: Pi · 1 skill",
      "Codex Search Off: Codex · 1 option",
    ]);
    // Agents and saved harnesses are headed apart.
    expect(browser.document.querySelector('[role="listbox"]')?.textContent).toContain(
      "Saved Harnesses",
    );
    await pick("Codex Search Off");
    expect(latest[0]).toMatchObject({ harnesses: ["codex"], harness: 3 });
    expect(trigger().textContent).toBe("Codex Search Off");
    // On Codex, the subagent harness is offered too.
    expect((await open()).map((entry) => entry.split(":")[0])).toEqual([
      "With Skills",
      "Haiku Subagents",
      "Codex Search Off",
    ]);
    // Picking the agent as it is drops the saved harness.
    await pick("Codex");
    expect(latest[0]).not.toHaveProperty("harness");
    expect(latest[0]?.harnesses).toEqual(["codex"]);
    expect(trigger().textContent).toBe("Codex");
    await act(async () => root.unmount());
  });
  // A row whose saved harness was deleted says so, so it can be changed.
  const deleted = renderToStaticMarkup(
    <RunModelTable
      models={[sol]}
      credentials={credentials}
      draft={drafted([row("codex", { harness: 99 })])}
      saved={[skills]}
      onChange={() => undefined}
    />,
  );
  expect(deleted).toContain("Deleted Harness");
  // A page that runs no saved harnesses offers none.
  const without = renderToStaticMarkup(
    <RunModelTable
      models={[sol]}
      credentials={credentials}
      draft={drafted([row("codex")])}
      onChange={() => undefined}
    />,
  );
  expect(without).not.toContain("Saved Harnesses");
});

test("the same model on an agent as it is and on a saved harness are two configurations", () => {
  const repeats = (...rows: ComparisonDraft["models"]) =>
    hasDuplicateModelSelections([sol], rows, credentials);
  expect(repeats(row("codex"), row("codex", { harness: 3 }))).toBe(false);
  expect(repeats(row("codex", { harness: 1 }), row("codex", { harness: 3 }))).toBe(false);
  expect(repeats(row("codex", { harness: 3 }), row("codex", { harness: 3 }))).toBe(true);
  expect(repeats(row("codex"), row("codex"))).toBe(true);
});
