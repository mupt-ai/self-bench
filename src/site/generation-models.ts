import { referencePricing } from "../evaluation/catalog-pricing.js";

/**
 * The models the hosted site offers for authoring and verification, and the credentials that
 * can run each of them. A model is invocable by its native provider's credential (OpenAI API
 * key, ChatGPT sign-in, or Anthropic) and by any OpenRouter credential; models without a
 * native provider are OpenRouter-only. Managed access is OpenRouter behind a platform key.
 */
export interface GenerationModelInfo {
  readonly id: string;
  readonly label: string;
  readonly vendor?: "openai" | "anthropic";
  /** The model id passed to Pi for OpenRouter-routed credentials and managed access. */
  readonly openRouter: string;
  /** Catalog id used for reference pricing, when the evaluation catalog carries this model. */
  readonly pricingId?: string;
}

const generationModelCatalog: readonly GenerationModelInfo[] = [
  {
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    vendor: "openai",
    openRouter: "openai/gpt-5.6-sol",
    pricingId: "router-sol56",
  },
  {
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    vendor: "openai",
    openRouter: "openai/gpt-6-astra",
    pricingId: "router-astra6",
  },
  {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    vendor: "anthropic",
    openRouter: "anthropic/claude-fable-5.1",
    pricingId: "router-fable51",
  },
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    vendor: "anthropic",
    openRouter: "anthropic/claude-opus-5",
    pricingId: "router-opus5",
  },
  { id: "glm-5.3", label: "GLM 5.3", openRouter: "z-ai/glm-5.3", pricingId: "router-glm53" },
  {
    id: "kimi-k3",
    label: "Kimi K3",
    openRouter: "moonshotai/kimi-k3",
    pricingId: "router-kimi3",
  },
];

export const generationModels = generationModelCatalog.map((model) => model.id) as [
  string,
  string,
  string,
  string,
  string,
  string,
];

function generationModelInfo(id: string): GenerationModelInfo | undefined {
  return generationModelCatalog.find((model) => model.id === id);
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

/** Reference rates ($/M tokens: input, output, cacheRead, cacheWrite) shared with evaluations. */
export function generationModelPricing(id: string) {
  const pricingId = generationModelInfo(id)?.pricingId;
  return pricingId ? referencePricing(pricingId) : undefined;
}
