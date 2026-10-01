import { chatgptSignInModels, findModel, nativePricing } from "../../contracts/models.js";
import { evaluationCatalog } from "../../evaluation/catalog.js";
import { routeFor } from "../../evaluation/models.js";
import { type GatewayId, gatewayIds, gatewayPricing, isGateway } from "../../gateways/index.js";

/** Generation uses the same live routes as evaluation. */
export function generationModels(): string[] {
  return evaluationCatalog().map((model) => model.id);
}
function generationModelInfo(id: string, catalog = evaluationCatalog()) {
  return catalog.find((model) => model.id === id);
}
export function generationModelLabel(id: string): string {
  return generationModelInfo(id)?.label ?? findModel(id)?.label ?? id;
}
function generationModelCredentialKinds(
  id: string,
  catalog = evaluationCatalog(),
): readonly string[] {
  const model = generationModelInfo(id, catalog);
  return model
    ? ["openai", "anthropic", ...gatewayIds].filter((kind) => routeFor(model, kind))
    : [];
}
export function generationCredentialSupportsModel(
  id: string,
  credential: { readonly kind: string; readonly auth: string },
  catalog = evaluationCatalog(),
): boolean {
  const model = generationModelInfo(id, catalog);
  if (!model) return false;
  if (credential.auth === "codex-login")
    return credential.kind === "openai" && chatgptSignInModels.has(id);
  if (credential.auth !== "api-key") return false;
  // Native provider routes are inferred from the vendor namespace; gateway routes require a listing.
  return generationModelCredentialKinds(id, catalog).includes(credential.kind);
}

/**
 * Resolves the Pi provider and model id for one stage's model under the selected credential.
 * Native credentials (including ChatGPT sign-in) invoke the vendor's model id directly, while
 * gateway credentials — and managed access, which is OpenRouter behind a platform key — route
 * through the gateway's prefixed model ids. Pi names each gateway's provider by its id.
 */
export function generationModelRoute(
  id: string,
  credential: { readonly kind: string; readonly auth: string } | undefined,
): { provider: "openai" | "openai-codex" | "anthropic" | GatewayId; model: string } {
  const info = generationModelInfo(id);
  if (!info) throw new Error(`Unknown generation model ${id}`);
  if (credential && !generationCredentialSupportsModel(id, credential))
    throw new Error(`Credential cannot run generation model ${id}`);
  if (!credential && !routeFor(info, "openrouter"))
    throw new Error(`OpenRouter does not offer generation model ${id}`);
  if (credential?.kind === "openai")
    return {
      provider: credential.auth === "codex-login" ? "openai-codex" : "openai",
      model: info.model,
    };
  if (credential?.kind === "anthropic")
    return {
      provider: "anthropic",
      model: info.model,
    };
  const kind = credential?.kind;
  const gateway = isGateway(kind) ? kind : "openrouter";
  const route = routeFor(info, gateway);
  if (!route) throw new Error(`Gateway does not offer generation model ${id}`);
  return { provider: gateway, model: route.model };
}

/** Reference rates for billing and cost estimates: generation runs through OpenRouter. */
export function generationModelPricing(id: string) {
  const info = generationModelInfo(id);
  const reference = findModel(id);
  const routed = info?.gateways?.openrouter;
  return routed
    ? gatewayPricing("openrouter", routed, reference?.rates?.gateway)
    : reference && nativePricing(reference);
}
