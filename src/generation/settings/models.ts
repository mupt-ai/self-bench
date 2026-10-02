import { type Model, models } from "../../contracts/models.js";
import {
  type GatewayId,
  gatewayIds,
  gatewayModelId,
  gatewayPricing,
  isGateway,
} from "../../gateways/index.js";

/**
 * The catalog models the hosted site offers for authoring and verification. A model is
 * invocable by its native provider's credential (OpenAI API key, ChatGPT sign-in, or
 * Anthropic) and by any gateway credential; models without a native provider are
 * gateway-only. Managed access is OpenRouter behind a platform key.
 */
const generationCatalog = models.filter((model) => model.generation);

export const generationModels = generationCatalog.map((model) => model.id) as [string, ...string[]];

function generationModelInfo(id: string): Model | undefined {
  return generationCatalog.find((model) => model.id === id);
}

export function generationModelLabel(id: string): string {
  return generationModelInfo(id)?.label ?? id;
}

/** Credential kinds that can invoke this model; gateway credentials serve every model. */
export function generationModelCredentialKinds(id: string): readonly string[] {
  const vendor = generationModelInfo(id)?.vendor;
  return vendor ? [vendor, ...gatewayIds] : gatewayIds;
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
  if (credential?.kind === "openai")
    return {
      provider: credential.auth === "codex-login" ? "openai-codex" : "openai",
      model: info.vendor === "openai" ? info.id : info.openRouter,
    };
  if (credential?.kind === "anthropic")
    return {
      provider: "anthropic",
      model: info.vendor === "anthropic" ? info.id : info.openRouter,
    };
  const kind = credential?.kind;
  const gateway = isGateway(kind) ? kind : "openrouter";
  return { provider: gateway, model: gatewayModelId(gateway, info.openRouter) };
}

/** Reference rates for billing and cost estimates: generation runs through OpenRouter. */
export function generationModelPricing(id: string) {
  const info = generationModelInfo(id);
  return info
    ? gatewayPricing("openrouter", info.openRouter, info.rates?.gateway, info.longContextFrom)
    : undefined;
}
