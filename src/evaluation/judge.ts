import type { CredentialInfo } from "../db/credentials.js";
import { gateways, isGateway } from "../gateways/index.js";
import {
  type HostVariable,
  JUDGE_VARIABLES,
  type JudgeNeeds,
} from "../harnesses/harbor/host-variables.js";

/** The judge variables a credential provides: its key, and the base URL it is reached at. */
export function judgeEnvironment(
  credential: Pick<CredentialInfo, "kind" | "auth" | "endpoint">,
  key: string,
): Record<string, string> {
  if (credential.auth !== "api-key") return {};
  const openAi = (base: string) => ({
    OPENAI_API_KEY: key,
    OPENAI_BASE_URL: base,
    OPENAI_API_BASE: base,
  });
  if (credential.kind === "openai") return openAi("https://api.openai.com/v1");
  if (credential.kind === "custom" && credential.endpoint) return openAi(credential.endpoint);
  if (credential.kind === "anthropic")
    return { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: "https://api.anthropic.com" };
  if (!isGateway(credential.kind)) return {};
  const gateway = gateways[credential.kind];
  return {
    ...openAi(gateway.openAiBase),
    ANTHROPIC_API_KEY: key,
    ANTHROPIC_BASE_URL: gateway.anthropicBase,
    ...(credential.kind === "openrouter"
      ? { OPENROUTER_API_KEY: key, OPENROUTER_API_BASE: gateway.openAiBase }
      : {}),
  };
}

/**
 * Why `credential` can't call a judge with `needs`, if it can't: it must give every required
 * variable, and at least one variable at all (or the judge would run with only its defaults).
 */
export function judgeCredentialRefusal(
  credential: Pick<CredentialInfo, "kind" | "auth" | "endpoint">,
  needs: JudgeNeeds,
): string | undefined {
  const provided = judgeEnvironment(credential, "key");
  const missing = needs.required.filter((name) => !(name in provided));
  if (missing.length)
    return `The judge credential can't provide ${missing.join(", ")}; select an API key for that provider or a gateway`;
  if (!needs.variables.some((name) => name in provided))
    return `The judge credential can't provide any of ${needs.variables.join(", ")}`;
  return undefined;
}

/**
 * Gives a published task's `env` tables their host variables for one trial, from `judge` (the
 * judge credential's variables) and nothing else. A judge variable only `verifier.env` reads goes
 * to the verifier directly (--verifier-env, as `${SELFBENCH_JUDGE_…}` so the key stays out of the
 * command line); one the sandbox reads is set in Harbor's environment, which the solver's own
 * credential may already hold under that name, in which case they must agree. Any other variable
 * must be unset, so its default applies. Returns the refusal when the trial can't run.
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
        refusal: `The task's sandbox reads ${name}, which the model being tested also uses: pick the same credential for the judge`,
      };
    else next[name] = value;
  }
  return { child: next, verifierEnv: [...verifierEnv] };
}
