import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import {
  credentialRunsHarness,
  defaultThinking,
  routeFor,
  thinkingOptions,
} from "../../../../src/evaluation/models";
import type { Harness } from "./api";

export const customModel: CatalogModel = {
  id: "custom",
  provider: "custom",
  model: "",
  label: "Custom Model",
  harnesses: ["pi"],
  source: "",
};

/** The prefix of a saved custom model's picker ID: `saved:<credential id>:<model id>`. */
const SAVED = "saved:";

/**
 * Each custom endpoint's saved model IDs as picker entries, labelled with their credential. They
 * stand for the Custom Model on that credential with that model ID (savedSelection).
 */
export function savedCustomModels(credentials: readonly CredentialInfo[]): CatalogModel[] {
  return credentials.flatMap((credential) =>
    credential.kind === "custom"
      ? (credential.models ?? []).map((model) => ({
          ...customModel,
          id: `${SAVED}${credential.id}:${model}`,
          model,
          label: `${model} (${credential.name})`,
        }))
      : [],
  );
}

/** The Custom Model selection a saved entry stands for, or undefined for any other model. */
export function savedSelection(
  model: CatalogModel,
  credentials: CredentialInfo[],
  requestedHarness?: Harness,
): ComparisonDraft["models"][number] | undefined {
  if (!model.id.startsWith(SAVED)) return undefined;
  const credentialId = model.id.slice(SAVED.length, model.id.indexOf(":", SAVED.length));
  const credential = credentials.find((entry) => entry.id === credentialId);
  if (!credential) return undefined;
  const picked =
    nextModelSelection(customModel, [credential], requestedHarness) ??
    nextModelSelection(customModel, [credential]);
  return {
    catalogId: customModel.id,
    customModel: model.model,
    credentialId,
    harnesses: picked?.harnesses ?? [],
  };
}

/** The picker entry a selection shows: its saved custom model when it is one. */
export function pickerValue(selection: ComparisonDraft["models"][number]): string {
  return selection.catalogId === customModel.id && selection.customModel && selection.credentialId
    ? `${SAVED}${selection.credentialId}:${selection.customModel}`
    : selection.catalogId;
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
        credentialRunsHarness(credential.auth, candidate),
    );
    if (harness) return { catalogId: model.id, credentialId: credential.id, harnesses: [harness] };
  }
  return undefined;
}

/** Whether the credential's route for the model, and its sign-in if any, runs every harness. */
export function credentialRunsAll(
  model: CatalogModel,
  credential: CredentialInfo,
  harnesses: Harness[],
): boolean {
  const route = routeFor(model, credential.kind);
  return (
    !!route &&
    harnesses.every(
      (harness) =>
        route.harnesses.includes(harness) && credentialRunsHarness(credential.auth, harness),
    )
  );
}

/**
 * Whether `candidate` repeats a selection: the same model, harness and effective thinking level.
 * A row without a chosen level runs at its route's default, which depends on its credential.
 */
export function hasModelSelection(
  model: CatalogModel,
  selections: ComparisonDraft["models"],
  candidate: ComparisonDraft["models"][number],
  credentials: readonly Pick<CredentialInfo, "id" | "kind">[],
): boolean {
  const subagentProvider = (selection: ComparisonDraft["models"][number]) =>
    credentials.find((entry) => entry.id === selection.subagent?.credentialId)?.kind;
  const effectiveThinking = (selection: ComparisonDraft["models"][number]) => {
    const kind = credentials.find((entry) => entry.id === selection.credentialId)?.kind;
    const route = kind ? routeFor(model, kind) : undefined;
    return (
      selection.thinking ?? defaultThinking(thinkingOptions(route ?? model, selection.harnesses))
    );
  };
  return selections.some(
    (selection) =>
      selection.catalogId === candidate.catalogId &&
      (selection.customModel ?? "") === (candidate.customModel ?? "") &&
      selection.subagent?.catalogId === candidate.subagent?.catalogId &&
      subagentProvider(selection) === subagentProvider(candidate) &&
      effectiveThinking(selection) === effectiveThinking(candidate) &&
      selection.harnesses.some((harness) => candidate.harnesses.includes(harness)),
  );
}

export function hasDuplicateModelSelections(
  models: CatalogModel[],
  selections: ComparisonDraft["models"],
  credentials: readonly Pick<CredentialInfo, "id" | "kind">[],
): boolean {
  return selections.some((selection, index) => {
    const model = models.find((entry) => entry.id === selection.catalogId);
    return !!model && hasModelSelection(model, selections.slice(0, index), selection, credentials);
  });
}
