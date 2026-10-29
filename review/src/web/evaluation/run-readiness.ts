import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonSelection } from "../../../../src/evaluation/comparisons";
import { routeFor, thinkingOptions } from "../../../../src/evaluation/models";
import { credentialRunsAll, customModel, hasDuplicateModelSelections } from "./model-selection";

/**
 * Whether a Run page's models and sandbox can start a comparison: every row has a model, a
 * credential that runs its harnesses, and a thinking level it offers, no row repeats another,
 * and the sandbox has its credential. The tasks are each page's own to check.
 */
export function selectionReady({
  draft,
  models,
  credentials,
  managedSandbox,
}: {
  draft: ComparisonSelection;
  models: CatalogModel[];
  credentials: CredentialInfo[];
  managedSandbox: boolean;
}): boolean {
  const selected = draft.models.filter((model) => model.harnesses.length > 0);
  return (
    selected.length > 0 &&
    selected.length === draft.models.length &&
    !hasDuplicateModelSelections([...models, customModel], draft.models, credentials) &&
    selected.length <= 12 &&
    (draft.sandbox === "managed"
      ? managedSandbox && draft.sandboxCredentialId === "managed-sandbox"
      : credentials.some(
          (credential) =>
            credential.id === draft.sandboxCredentialId && credential.kind === draft.sandbox,
        )) &&
    selected.every((selection) => {
      const model =
        selection.catalogId === "custom"
          ? customModel
          : models.find((entry) => entry.id === selection.catalogId);
      const credential = credentials.find((entry) => entry.id === selection.credentialId);
      if (!model || !credential) return false;
      if (selection.subagent) {
        const secondary = models.find((entry) => entry.id === selection.subagent?.catalogId);
        const secondaryCredential = credentials.find(
          (entry) => entry.id === selection.subagent?.credentialId,
        );
        if (
          selection.harnesses.some((harness) => harness !== "claude-code") ||
          !secondary ||
          !secondaryCredential ||
          !credentialRunsAll(secondary, secondaryCredential, ["claude-code"]) ||
          (selection.catalogId === selection.subagent.catalogId &&
            credential.kind === secondaryCredential.kind)
        )
          return false;
      }
      const route = routeFor(model, credential.kind);
      const levels = thinkingOptions(route ?? model, selection.harnesses);
      return (
        credentialRunsAll(model, credential, selection.harnesses) &&
        (!selection.thinking || levels.includes(selection.thinking)) &&
        (model.id !== "custom" || !!selection.customModel)
      );
    })
  );
}

/** The org's credentials as Run pages offer them, with the platform's when it manages models. */
export function runCredentials(
  credentials: CredentialInfo[] | undefined,
  managedModels: boolean | undefined,
): CredentialInfo[] {
  return [
    ...(managedModels
      ? [
          {
            id: "managed-model",
            name: "Managed",
            kind: "openrouter" as const,
            auth: "api-key" as const,
            createdAt: "",
          },
        ]
      : []),
    ...(credentials ?? []),
  ];
}
