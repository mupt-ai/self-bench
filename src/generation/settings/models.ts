import type { CredentialInfo } from "../../db/credentials.js";
import { type CatalogModel, evaluationCatalog } from "../../evaluation/catalog.js";
import { routeFor } from "../../evaluation/models.js";
import type { GatewayId } from "../../gateways/index.js";

/**
 * Generation offers the run page's models: the curated catalog plus every model the gateways
 * list (evaluationCatalog). Authoring and verification run in Pi, which every route drives: a
 * model's native provider key (OpenAI API key, ChatGPT sign-in, or Anthropic) and any gateway
 * that serves it. Managed access is OpenRouter behind a platform key.
 */
export function generationModel(id: string): CatalogModel | undefined {
  return evaluationCatalog().find((model) => model.id === id);
}

/** Whether a stored credential can run the model in Pi. */
export function generationCredentialRuns(
  model: CatalogModel,
  credential: Pick<CredentialInfo, "kind" | "auth">,
): boolean {
  if (credential.auth === "codex-login")
    return credential.kind === "openai" && model.provider === "openai";
  return credential.auth === "api-key" && !!routeFor(model, credential.kind);
}

/** Whether managed access, which is OpenRouter behind a platform key, can run the model. */
export function managedRuns(model: CatalogModel): boolean {
  return !!routeFor(model, "openrouter");
}

/**
 * Resolves the Pi provider and model id for one stage's model under the selected credential, or
 * under managed access (no credential), which is OpenRouter behind a platform key. Pi names each
 * gateway's provider by its id, and a ChatGPT sign-in "openai-codex".
 */
export function generationModelRoute(
  id: string,
  credential: Pick<CredentialInfo, "kind" | "auth"> | undefined,
): { provider: "openai" | "openai-codex" | "anthropic" | GatewayId; model: string } {
  const model = generationModel(id);
  if (!model) throw new Error(`Unknown generation model ${id}`);
  const route = routeFor(model, credential?.kind ?? "openrouter");
  if (
    !route ||
    route.provider === "custom" ||
    (credential && !generationCredentialRuns(model, credential))
  )
    throw new Error(`${model.label} cannot run on this credential`);
  return {
    provider: credential?.auth === "codex-login" ? "openai-codex" : route.provider,
    model: route.model,
  };
}

/** Reference rates for billing and cost estimates: managed generation runs through OpenRouter. */
export function generationModelPricing(id: string) {
  const model = generationModel(id);
  return model && routeFor(model, "openrouter")?.pricing;
}
