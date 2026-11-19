import { executionEnvironment } from "../../contracts/config/execution-environment.js";
import { type GatewayId, gatewayIds, gateways, modelApiKeyVariable } from "../../gateways/index.js";
import { platformModelKey } from "../../generation/billing/managed.js";

type PiModelAuthProvider = "openai" | "anthropic" | "dari-link" | GatewayId;

/**
 * The environment variable a generation stage's Dari Link child token travels under. Its own name,
 * not a provider key's, so Pi takes the connection as its provider (`dari-link`), not OpenAI's.
 */
export const PI_DARI_LINK_KEY = "SELFBENCH_PI_DARI_LINK_KEY";

export interface PiModelAuth {
  readonly provider: PiModelAuthProvider;
  readonly apiKey: string;
}

function environment(): NodeJS.ProcessEnv {
  return executionEnvironment();
}

/** The sandbox secrets that authenticate Pi for this resolved provider. */
export function piModelAuthSecrets(auth: PiModelAuth): Record<string, string> {
  return { [modelApiKeyVariable(auth.provider)]: auth.apiKey };
}

/**
 * Resolves the credentials a sandbox's Pi invocation should authenticate with. Generation
 * runs place exactly one provider credential in the environment, so the key variables are
 * checked in a fixed order; a self-managed worker's platform key applies next.
 */
export async function loadPiModelAuth(): Promise<PiModelAuth> {
  const env = environment();
  const dariLink = env[PI_DARI_LINK_KEY]?.trim();
  if (dariLink) return { provider: "dari-link", apiKey: dariLink };
  const openAi = env.OPENAI_API_KEY?.trim();
  if (openAi) return { provider: "openai", apiKey: openAi };
  const anthropic = env.ANTHROPIC_API_KEY?.trim();
  if (anthropic) return { provider: "anthropic", apiKey: anthropic };
  for (const gateway of gatewayIds) {
    const key = env[gateways[gateway].keyVariable]?.trim();
    if (key) return { provider: gateway, apiKey: key };
  }
  const managed = platformModelKey(env);
  if (managed) return { provider: "openrouter", apiKey: managed };
  throw new Error("No model credential for Pi: the run names none, and no platform key is set");
}
