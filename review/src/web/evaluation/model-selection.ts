import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { defaultThinking, routeFor, thinkingOptions } from "../../../../src/evaluation/models";
import { matchesQuery } from "../word-search";
import type { Harness } from "./api";

export const customModel: CatalogModel = {
  id: "custom",
  provider: "custom",
  model: "",
  label: "Custom Model",
  harnesses: ["pi"],
  source: "",
};

/**
 * The models whose name or id has a word starting with each word of `query`, in catalog order, so
 * "kimi" or "qwen coder" narrow hundreds of models. The row's current model always stays listed.
 */
export function matchingModels(
  models: CatalogModel[],
  query: string,
  selectedId: string,
): CatalogModel[] {
  return models.filter(
    (model) => model.id === selectedId || matchesQuery(`${model.label} ${model.id}`, query),
  );
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
    selection.thinking ?? defaultThinking(thinkingOptions(model, selection.harnesses));
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
