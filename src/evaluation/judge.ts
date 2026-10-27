import type { CredentialInfo } from "../db/credentials.js";
import type { GatewayConnection } from "../gateway/connection.js";
import { gatewayIds } from "../gateways/index.js";
import { type HostVariable, JUDGE_VARIABLES } from "../harnesses/harbor/host-variables.js";

/** Credential kinds whose keys can judge: the gateway serves any of their provider's models. */
const JUDGE_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "meta",
  ...gatewayIds,
]);

/**
 * The judge variables a gateway connection provides: the trial key at the gateway's OpenAI and
 * Anthropic addresses, which serve any model of the judge credential's provider in either protocol.
 */
export function judgeEnvironment(
  connection: Pick<GatewayConnection, "key" | "openAiBase" | "anthropicBase">,
): Record<string, string> {
  const { key, openAiBase } = connection;
  return {
    OPENAI_API_KEY: key,
    OPENAI_BASE_URL: openAiBase,
    OPENAI_API_BASE: openAiBase,
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_BASE_URL: connection.anthropicBase,
    OPENROUTER_API_KEY: key,
    OPENROUTER_API_BASE: openAiBase,
  };
}

/**
 * Why `credential` can't call a task's LLM judge, if it can't: it must be an API key the gateway
 * serves its provider's models on, which gives the judge every variable it may read.
 */
export function judgeCredentialRefusal(
  credential: Pick<CredentialInfo, "kind" | "auth">,
): string | undefined {
  return credential.auth === "api-key" && JUDGE_PROVIDERS.has(credential.kind)
    ? undefined
    : "The judge credential must be an API key for a model provider or a gateway";
}

/**
 * Gives a published task's `env` tables their host variables for one trial, from `judge` (the
 * gateway's variables for the trial key) and nothing else. A judge variable only `verifier.env`
 * reads goes to the verifier directly (--verifier-env, as `${SELFBENCH_JUDGE_…}` so the key stays
 * out of the command line); one the sandbox reads is set in Harbor's environment. A gateway solver
 * holds the same key and address there; only Dari's router, called directly, holds its own, which
 * a sandbox-read judge variable cannot replace. Any other variable must be unset, so its default
 * applies. Returns the refusal when the trial can't run.
 */
export function judgeTrial(
  variables: readonly HostVariable[],
  child: NodeJS.ProcessEnv,
  judge: Readonly<Record<string, string>>,
): { child: NodeJS.ProcessEnv; verifierEnv: string[] } | { refusal: string } {
  const next = { ...child };
  const verifierEnv = new Set<string>();
  for (const { name, verifierOnly, required, fallback } of variables) {
    const value = JUDGE_VARIABLES.has(name) ? judge[name] : undefined;
    if (value === undefined) {
      if (required && JUDGE_VARIABLES.has(name))
        return { refusal: `The task's judge needs ${name}: select a judge credential` };
      // Not the judge's: it takes its default, never the worker's value (such as the solver's own
      // key under the same name). The verifier's is set to it outright; the sandbox's can't be.
      if (child[name] === undefined) continue;
      if (verifierOnly && fallback !== undefined) verifierEnv.add(`${name}=${fallback}`);
      else return { refusal: `The task reads ${name} from the worker` };
      continue;
    }
    if (verifierOnly) {
      next[`SELFBENCH_JUDGE_${name}`] = value;
      verifierEnv.add(`${name}=\${SELFBENCH_JUDGE_${name}}`);
    } else if (child[name] !== undefined && child[name] !== value)
      return {
        refusal: `The task's sandbox reads ${name}, which the model being tested also uses: a judge in the sandbox cannot share it`,
      };
    else next[name] = value;
  }
  return { child: next, verifierEnv: [...verifierEnv] };
}
