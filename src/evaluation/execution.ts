import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { dariEndpoint, validateEndpoint } from "../db/credentials.js";
import type { Vault } from "../db/vault.js";
import type { TrialJudge } from "../gateway/trial-key.js";
import { MANAGED_MODEL_CREDENTIAL } from "../gateway/trial-key.js";
import { modelApiKeyVariable } from "../gateways/index.js";
import {
  managedModalEnvironment,
  managedSandboxCredentials,
} from "../generation/billing/managed.js";
import { providerCredentialEnvironment } from "../sandbox/provider-environment.js";
import { trialRoute } from "./gateway-trial.js";
import { judgeCredentialRefusal } from "./judge.js";
import { signInRefusal } from "./models.js";
import { refuseTrial } from "./refusal.js";
import { sameScope } from "./scope.js";
import type { EvaluationInput, Harness } from "./types.js";
/** The organization whose credentials an evaluation uses. */
export function evaluationCredentialOrg(
  input: Pick<EvaluationInput, "credentialOrgId" | "credentialOwnerId">,
): number | undefined {
  return input.credentialOrgId ?? input.credentialOwnerId;
}

/**
 * Resolves the comparison's saved credentials into a clean Harbor process environment for one
 * harness's trial. A gateway route (an API key or a ChatGPT or Claude sign-in) leaves the secret in
 * the vault: the gateway reads it itself, so the worker puts a model credential in the environment
 * only on a direct route, and none without a harness (building task images calls no model). A
 * judge's key stays in the vault too.
 */
export async function credentialExecution(
  input: EvaluationInput,
  home: string,
  env: NodeJS.ProcessEnv,
  { credentials, comparisons }: Pick<Vault, "credentials" | "comparisons">,
  harness?: Harness,
) {
  const orgId = evaluationCredentialOrg(input);
  if (!input.credentials || !orgId || !input.comparisonId)
    throw refuseTrial("Credential references missing");
  const comparison = await comparisons.find(input.comparisonId);
  const saved =
    comparison?.orgId === orgId && sameScope(comparison.scope, input)
      ? comparison.inputs.find((entry) => entry.id === input.id)
      : undefined;
  // A trial workflow carries only its own task (trialInput); the rest must match exactly.
  const reserved =
    saved && input.tasks.length === 1
      ? { ...saved, tasks: saved.tasks.filter((task) => isDeepStrictEqual(task, input.tasks[0])) }
      : saved;
  if (!reserved || !isDeepStrictEqual(reserved, input))
    throw refuseTrial("Execution does not match the reserved comparison");
  const managedModel = input.credentials.modelCredentialId === MANAGED_MODEL_CREDENTIAL;
  const managedSandbox = input.credentials.sandboxCredentialId === "managed-sandbox";
  const info = managedModel
    ? { id: MANAGED_MODEL_CREDENTIAL, kind: "openrouter" as const, auth: "api-key" as const }
    : await credentials.find(orgId, input.credentials.modelCredentialId);
  const sandbox = managedSandbox
    ? { id: "managed-sandbox", kind: input.sandbox }
    : await credentials.find(orgId, input.credentials.sandboxCredentialId);
  if (
    !info ||
    !sandbox ||
    sandbox.kind !== input.sandbox ||
    info.kind !== input.credentials.provider
  )
    throw refuseTrial("Credential unavailable");
  const refusal = signInRefusal(info.auth, input.harnesses);
  if (refusal) throw refuseTrial(refusal);
  const route = harness ? trialRoute(input, harness, info.auth) : undefined;
  // On the gateway route the gateway reads the API key itself (or the platform's, when managed).
  const modelSecret =
    route === "direct" ? (await credentials.secret(orgId, info.id))?.value : undefined;
  const managedE2B =
    managedSandbox && input.sandbox === "e2b" ? managedSandboxCredentials(env) : undefined;
  const managedModal =
    managedSandbox && input.sandbox === "modal" ? managedModalEnvironment(env) : undefined;
  const sandboxSecret = managedE2B
    ? { value: managedE2B.apiKey }
    : managedModal
      ? { value: managedModal.MODAL_TOKEN_SECRET, tokenId: managedModal.MODAL_TOKEN_ID }
      : await credentials.secret(orgId, sandbox.id);
  if ((route === "direct" && !modelSecret) || !sandboxSecret)
    throw refuseTrial("Credential unavailable");
  const child: NodeJS.ProcessEnv = {
    PATH: env.PATH,
    HOME: home,
    TMPDIR: home,
    LANG: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
  };
  const secrets = [modelSecret ?? "", sandboxSecret.value, sandboxSecret.tokenId ?? ""].filter(
    Boolean,
  );
  if (modelSecret && info.auth === "muse-login") {
    // Muse Code mints its subscription key from the sign-in's token at startup (harbor_muse.py).
    const authPath = join(home, "muse-auth.json");
    await writeFile(authPath, modelSecret, { mode: 0o600 });
    child.MUSE_AUTH_JSON_PATH = authPath;
    secrets.push(JSON.parse(modelSecret).providers.meta.access_token);
  } else if (modelSecret) {
    // A direct API key: Dari's router (or a custom endpoint serving it), or Muse Code's Meta key.
    child[modelApiKeyVariable(info.kind)] = modelSecret;
    const endpoint = "endpoint" in info ? info.endpoint : undefined;
    if (info.kind === "dari") child.OPENAI_BASE_URL = dariEndpoint(endpoint);
    if (info.kind === "custom") child.OPENAI_BASE_URL = validateEndpoint(endpoint ?? "", env);
  }
  Object.assign(
    child,
    providerCredentialEnvironment(input.sandbox, { ...sandboxSecret, domain: managedE2B?.domain }),
    managedModal ? { MODAL_ENVIRONMENT: managedModal.MODAL_ENVIRONMENT } : {},
  );
  return {
    profile: { model: input.modelName },
    child,
    secrets,
    auth: info.auth,
    route,
    credential: { orgId, id: info.id },
    judge: await trialJudge(input, orgId, credentials),
  };
}

/** The credential a benchmark's LLM judge calls with through the gateway, if it has one. */
async function trialJudge(
  input: EvaluationInput,
  orgId: number,
  credentials: Vault["credentials"],
): Promise<TrialJudge | undefined> {
  const id = input.credentials?.judgeCredentialId;
  if (!id) return undefined;
  const info = await credentials.find(orgId, id);
  if (!info || judgeCredentialRefusal(info)) throw refuseTrial("Judge credential unavailable");
  return { credentialId: info.id, provider: info.kind };
}
