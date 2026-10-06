import type { CredentialInfo } from "../../../../src/db/credentials";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { routeFor, thinkingOptions } from "../../../../src/evaluation/models";
import { credentialRunsAll, customModel, hasDuplicateModelSelections } from "./model-selection";

/** The managed model credential: OpenRouter on SelfBench's key, offered when the platform has one. */
export function credentialsWithManaged(
  managed: { models: boolean } | undefined,
  credentials: CredentialInfo[] | undefined,
): CredentialInfo[] {
  return [
    ...(managed?.models
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

/**
 * Whether the models and sandbox of a draft can run: each row complete, on a credential that
 * reaches its model with every chosen harness, none repeated, and a sandbox to run on.
 */
export function settingsReady({
  draft,
  models,
  credentials,
  managed,
}: {
  draft: Pick<ComparisonDraft, "models" | "sandbox" | "sandboxCredentialId">;
  models: CatalogModel[];
  credentials: CredentialInfo[];
  managed: { sandbox: boolean } | undefined;
}): boolean {
  const selected = draft.models.filter((model) => model.harnesses.length > 0);
  return (
    selected.length > 0 &&
    selected.length === draft.models.length &&
    !hasDuplicateModelSelections([...models, customModel], draft.models, credentials) &&
    selected.length <= 12 &&
    (draft.sandbox === "managed"
      ? !!managed?.sandbox && draft.sandboxCredentialId === "managed-sandbox"
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
