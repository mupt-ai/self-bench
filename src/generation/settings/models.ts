import { type Model, modelPricing, models } from "../../contracts/models.js";

/**
 * The catalog models the hosted site offers for authoring and verification. A model is
 * invocable by its native provider's credential (OpenAI API key, ChatGPT sign-in, or
 * Anthropic) and by any OpenRouter credential; models without a native provider are
 * OpenRouter-only. Managed access is OpenRouter behind a platform key.
 */
const generationCatalog = models.filter((model) => model.generation);

export const generationModels = generationCatalog.map((model) => model.id) as [string, ...string[]];

function generationModelInfo(id: string): Model | undefined {
  return generationCatalog.find((model) => model.id === id);
}

export function generationModelLabel(id: string): string {
  return generationModelInfo(id)?.label ?? id;
}

/** Credential kinds that can invoke this model; OpenRouter credentials serve every model. */
export function generationModelCredentialKinds(id: string): readonly string[] {
  const vendor = generationModelInfo(id)?.vendor;
  return vendor ? [vendor, "openrouter"] : ["openrouter"];
}

/**
 * Resolves the Pi provider and model id for one stage's model under the selected credential.
 * Native credentials (including ChatGPT sign-in) invoke the vendor's model id directly, while
 * OpenRouter credentials — and managed access, which is OpenRouter behind a platform key —
 * route through OpenRouter's prefixed model ids.
 */
export function generationModelRoute(
  id: string,
  credential: { readonly kind: string; readonly auth: string } | undefined,
): { provider: "openai" | "openai-codex" | "anthropic" | "openrouter"; model: string } {
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
  return { provider: "openrouter", model: info.openRouter };
}

/** Reference rates for billing and cost estimates: generation runs through OpenRouter. */
export function generationModelPricing(id: string) {
  const info = generationModelInfo(id);
  return info ? modelPricing(info, "openRouter") : undefined;
}
