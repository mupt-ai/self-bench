import type { CredentialInfo } from "../../../../src/evaluation/account";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { routeFor } from "../../../../src/evaluation/model-options";

export function nextModelSelection(
  model: CatalogModel,
  credentials: CredentialInfo[],
): ComparisonDraft["models"][number] | undefined {
  for (const credential of credentials) {
    const harness = routeFor(model, credential.kind)?.harnesses.find(
      (candidate) => credential.auth !== "codex-login" || candidate === "codex",
    );
    if (harness) return { catalogId: model.id, credentialId: credential.id, harnesses: [harness] };
  }
  return { catalogId: model.id, credentialId: "", harnesses: [] };
}
