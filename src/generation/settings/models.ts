import type { CredentialInfo } from "../../db/credentials.js";
import { type CatalogModel, evaluationCatalog } from "../../evaluation/catalog.js";
import { modelRoutes, routeFor } from "../../evaluation/models.js";
import {
  type GatewayId,
  gatewayIds,
  isGateway,
  type ListedModel,
  listedModels,
} from "../../gateways/index.js";

/** The catalog by id, as of the gateway listings it was built from. */
let indexed:
  | { listings: readonly (readonly ListedModel[])[]; models: Map<string, CatalogModel> }
  | undefined;

/**
 * Generation offers the run page's models: the curated catalog plus every model the gateways
 * list (evaluationCatalog). Authoring and verification run in Pi, which every route drives: a
 * model's native provider key (OpenAI API key, ChatGPT sign-in, or Anthropic) and any gateway
 * that serves it. Managed access is OpenRouter behind a platform key.
 */
export function generationModel(id: string): CatalogModel | undefined {
  // Building the catalog merges every listing, and stages and usage rows look models up often,
  // so it is rebuilt only when a refresh replaces a listing.
  const listings = gatewayIds.map(listedModels);
  if (!indexed || listings.some((listing, index) => listing !== indexed?.listings[index]))
    indexed = { listings, models: new Map(evaluationCatalog().map((model) => [model.id, model])) };
  return indexed.models.get(id);
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

/**
 * Whether managed access, which is OpenRouter behind a platform key, can run the model: whether
 * OpenRouter serves it, which every catalog model records in its gateway ids.
 */
export function managedRuns(model: CatalogModel): boolean {
  return !!model.gateways?.openrouter;
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
  const runs = credential ? generationCredentialRuns(model, credential) : managedRuns(model);
  const route = runs ? routeFor(model, credential?.kind ?? "openrouter") : undefined;
  // Catalog models never route to a custom endpoint; the check narrows the provider.
  if (!route || route.provider === "custom")
    throw new Error(`${model.label} cannot run on this credential`);
  return {
    provider: credential?.auth === "codex-login" ? "openai-codex" : route.provider,
    model: route.model,
  };
}

/** OpenRouter's rates, which managed generation runs through and is billed at. */
export function managedModelPricing(id: string) {
  const model = generationModel(id);
  return model && routeFor(model, "openrouter")?.pricing;
}

/**
 * Reference rates for cost estimates: OpenRouter's, or another gateway's for a model only it
 * serves, which a credential on that gateway can still run.
 */
export function generationModelPricing(id: string) {
  const model = generationModel(id);
  return (
    managedModelPricing(id) ??
    (model &&
      modelRoutes(model).find((route) => isGateway(route.provider) && route.pricing)?.pricing)
  );
}
