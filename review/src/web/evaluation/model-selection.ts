import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { routeFor, thinkingOptions } from "../../../../src/evaluation/models";
import type { Harness } from "./api";

export const customModel: CatalogModel = {
  id: "custom",
  provider: "custom",
  model: "",
  label: "Custom Model",
  harnesses: ["pi"],
  source: "",
};

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[\s:·()/._-]+/)
    .filter(Boolean);

/**
 * The models whose name or id has a word starting with each word of `query`, in catalog order, so
 * "kimi" or "qwen coder" narrow hundreds of models. The row's current model always stays listed.
 */
export function matchingModels(
  models: CatalogModel[],
  query: string,
  selectedId: string,
): CatalogModel[] {
  const wanted = words(query);
  return models.filter((model) => {
    if (model.id === selectedId) return true;
    const own = words(`${model.label} ${model.id}`);
    return wanted.every((word) => own.some((part) => part.startsWith(word)));
  });
}

export function nextModelSelection(
  model: CatalogModel,
  credentials: CredentialInfo[],
  requestedHarness?: Harness,
): ComparisonDraft["models"][number] | undefined {
  for (const credential of credentials) {
    const harness = routeFor(model, credential.kind)?.harnesses.find(
      (candidate) =>
        (!requestedHarness || requestedHarness === candidate) &&
        (credential.auth !== "codex-login" || candidate === "codex"),
    );
    if (harness) return { catalogId: model.id, credentialId: credential.id, harnesses: [harness] };
  }
  return undefined;
}

export function hasModelSelection(
  model: CatalogModel,
  selections: ComparisonDraft["models"],
  candidate: ComparisonDraft["models"][number],
): boolean {
  const effectiveThinking = (selection: ComparisonDraft["models"][number]) =>
    selection.thinking ??
    (thinkingOptions(model, selection.harnesses).includes("high") ? "high" : "default");
  return selections.some(
    (selection) =>
      selection.catalogId === candidate.catalogId &&
      (selection.customModel ?? "") === (candidate.customModel ?? "") &&
      effectiveThinking(selection) === effectiveThinking(candidate) &&
      selection.harnesses.some((harness) => candidate.harnesses.includes(harness)),
  );
}

export function hasDuplicateModelSelections(
  models: CatalogModel[],
  selections: ComparisonDraft["models"],
): boolean {
  return selections.some((selection, index) => {
    const model = models.find((entry) => entry.id === selection.catalogId);
    return !!model && hasModelSelection(model, selections.slice(0, index), selection);
  });
}
