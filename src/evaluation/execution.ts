import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { ApplicationFailure } from "@temporalio/common";
import type { ThinkingLevel } from "../contracts/models.js";
import { dariEndpoint, validateEndpoint } from "../db/credentials.js";
import type { Vault } from "../db/vault.js";
import type { GatewayConnection } from "../gateway/connection.js";
import { MANAGED_MODEL_CREDENTIAL, type PinnedThinking } from "../gateway/trial-key.js";
import { gateways, isGateway, listedModel, modelApiKeyVariable } from "../gateways/index.js";
import {
  managedModalEnvironment,
  managedSandboxCredentials,
} from "../generation/billing/managed.js";
import { providerCredentialEnvironment } from "../sandbox/provider-environment.js";
import { isDariRun } from "./dari/cost.js";
import { judgeEnvironment } from "./judge.js";
import { signInRefusal, thinkingArguments } from "./models.js";
import { sameScope } from "./scope.js";
import type { EvaluationInput, Harness } from "./types.js";

/**
 * A trial setup failure that every attempt would meet again (a missing or oversized bundle, an
 * unusable credential, an unsupported Harbor): the trial fails at once instead of retrying.
 */
export function refuseTrial(message: string): ApplicationFailure {
  return ApplicationFailure.nonRetryable(message, "TrialRefused");
}

/** The organization whose credentials an evaluation uses. */
export function evaluationCredentialOrg(
  input: Pick<EvaluationInput, "credentialOrgId" | "credentialOwnerId">,
): number | undefined {
  return input.credentialOrgId ?? input.credentialOwnerId;
}

/**
 * Resolves the comparison's saved credentials into a clean Harbor process environment for one
 * harness's trial. A gateway route (an API key) leaves the key in the vault: the gateway reads it
 * itself, so the worker puts a model credential in the environment only on a direct route, and
 * none without a harness (building task images calls no model).
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
  if (modelSecret && info.auth === "codex-login") {
    const authPath = join(home, "codex-auth.json");
    await writeFile(authPath, modelSecret, { mode: 0o600 });
    child.CODEX_AUTH_JSON_PATH = authPath;
    const auth = JSON.parse(modelSecret);
    secrets.push(
      ...Object.values(auth.tokens).filter((value): value is string => typeof value === "string"),
    );
  } else if (modelSecret && info.auth === "muse-login") {
    // Muse Code mints its subscription key from the sign-in's token at startup (harbor_muse.py).
    const authPath = join(home, "muse-auth.json");
    await writeFile(authPath, modelSecret, { mode: 0o600 });
    child.MUSE_AUTH_JSON_PATH = authPath;
    secrets.push(JSON.parse(modelSecret).providers.meta.access_token);
  } else if (modelSecret && info.auth === "claude-login") {
    // Harbor's Claude Code passes the token through and drops any API key once forced.
    child.CLAUDE_CODE_OAUTH_TOKEN = modelSecret;
    child.CLAUDE_FORCE_OAUTH = "1";
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
  const judge = await judgeCredentialEnvironment(input, orgId, credentials, env);
  if (judge.secret) secrets.push(judge.secret);
  return {
    profile: { model: input.modelName },
    child,
    secrets,
    auth: info.auth,
    route,
    credential: { orgId, id: info.id },
    judge: judge.env,
  };
}

/** The judge variables a benchmark's LLM judge calls with, from its judge credential. */
async function judgeCredentialEnvironment(
  input: EvaluationInput,
  orgId: number,
  credentials: Vault["credentials"],
  env: NodeJS.ProcessEnv,
): Promise<{ env: Record<string, string>; secret?: string }> {
  const id = input.credentials?.judgeCredentialId;
  if (!id) return { env: {} };
  const info = await credentials.find(orgId, id);
  const secret = info ? (await credentials.secret(orgId, id))?.value : undefined;
  if (!info || !secret || info.auth !== "api-key")
    throw refuseTrial("Judge credential unavailable");
  const endpoint = info.endpoint ? validateEndpoint(info.endpoint, env) : undefined;
  return { env: judgeEnvironment({ ...info, ...(endpoint ? { endpoint } : {}) }, secret), secret };
}

function hostsFromEnvironment(env: NodeJS.ProcessEnv): string[] {
  return ["OPENAI_BASE_URL", "OPENAI_API_BASE", "ANTHROPIC_BASE_URL"]
    .flatMap((key) => {
      const value = env[key];
      if (!value) return [];
      try {
        return [new URL(value).hostname];
      } catch {
        return [];
      }
    })
    .filter((host, index, hosts) => hosts.indexOf(host) === index);
}

/** The hosts a trial that calls its vendor directly (a sign-in, or Dari's router) must reach. */
function directHosts(provider: string | undefined, env: NodeJS.ProcessEnv): string[] {
  // Codex subscription traffic goes to ChatGPT, not the OpenAI API.
  if (env.CODEX_AUTH_JSON_PATH) return ["chatgpt.com", "*.chatgpt.com", "auth.openai.com"];
  const endpointHosts = hostsFromEnvironment(env);
  if (endpointHosts.length) return endpointHosts;
  if (provider === "anthropic") return ["api.anthropic.com"];
  if (provider === "meta") return ["api.meta.ai"];
  return [];
}

/**
 * How a trial's agent reaches its model. An API key goes through SelfBench's gateway, which pins
 * the model, holds the key, and records each call's cost. Three routes stay direct: a sign-in (the
 * gateway serves no subscriptions yet), Dari's router (dari/cost.ts prices it by its own response),
 * and Muse Code on a Meta key (its CLI takes bare model ids, which the gateway's `dari/model/` ids
 * are not, so it keeps Meta's endpoint).
 */
export type TrialRoute = "gateway" | "direct";

export function trialRoute(
  input: Pick<EvaluationInput, "credentials" | "modelName">,
  harness: Harness,
  auth = input.credentials?.auth ?? "api-key",
): TrialRoute {
  if (auth !== "api-key" || isDariRun(input)) return "direct";
  if (harness === "muse-code" && input.credentials?.provider === "meta") return "direct";
  return "gateway";
}

/** The gateway's id for the trial's model, `provider/model`: a custom endpoint's under `custom/`. */
export function gatewayModelId(input: Pick<EvaluationInput, "credentials" | "modelName">): string {
  return input.credentials?.provider === "custom"
    ? `custom/${input.modelName.slice(input.modelName.indexOf("/") + 1)}`
    : input.modelName;
}

/** The model name a gateway trial's requests carry, which the gateway serves exactly. */
export function gatewayRequestModel(input: Pick<EvaluationInput, "credentials" | "modelName">) {
  return `dari/model/${gatewayModelId(input)}`;
}

/**
 * The thinking level the gateway pins a trial to. It is pinned for every harness but Claude Code,
 * which sends its own effort on each call: the gateway drops Codex's effort (it routes it itself),
 * and Pi, Mini-SWE-Agent and Terminus 2 send none. Claude Code's side calls disable thinking,
 * which a pinned level would refuse. At the provider default nothing is pinned.
 */
export function pinnedThinking(
  harness: Harness,
  level?: ThinkingLevel,
): PinnedThinking | undefined {
  return harness === "claude-code" || !level || level === "default" ? undefined : level;
}

/** Pi's provider name for the gateway, in the models.json the trial writes for it. */
const PI_GATEWAY_PROVIDER = "selfbench";

/** Variables any model key or endpoint could travel under; a gateway trial's agent gets none. */
const MODEL_VARIABLES = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "META_API_KEY",
  "MUSE_CODE_BASE_URL",
  ...Object.values(gateways).map((gateway) => gateway.keyVariable),
];

/** What Harbor runs a trial's solver as: its agent, model name, arguments, environment and hosts. */
export interface SolverTrial {
  model: string;
  agent: string;
  agentArguments: string[];
  child: NodeJS.ProcessEnv;
  extraAllowedHosts: string[];
}

/**
 * Adapts a trial's connection to its harness. Through the gateway (`connection`), every harness
 * gets the gateway's address and the trial key under the variables its protocol reads, and asks
 * for the one model the key serves. Direct, it keeps the sign-in or Dari router's own settings.
 */
export function gatewayTrial(
  input: EvaluationInput,
  harness: Harness,
  model: string,
  env: NodeJS.ProcessEnv,
  connection?: GatewayConnection,
): SolverTrial {
  if (connection) return gatewayRouted(input, harness, env, connection);
  if (trialRoute(input, harness) === "gateway")
    throw refuseTrial("Model gateway connection is missing");
  const provider = input.credentials?.provider;
  const dari = provider === "dari" || isDariRun(input);
  const child = { ...env };
  return {
    model: provider === "dari" ? "openai/dari/routing" : model,
    agent: directAgent(harness, input),
    // Harbor needs an explicit API style for Dari's Chat Completions endpoint.
    agentArguments: [
      ...thinkingArguments(harness, input.thinking),
      ...(harness === "pi" && dari ? ["--agent-kwarg", "model_api=openai-completions"] : []),
    ],
    child,
    extraAllowedHosts: directHosts(provider, child),
  };
}

/** The Harbor agent for a harness on a direct route. */
function directAgent(harness: Harness, input: EvaluationInput): string {
  if (harness === "claude-code") return "harbor_gateway:SelfBenchClaudeCode";
  if (harness === "muse-code") return "harbor_muse:SelfBenchMuseCode";
  if (harness === "pi") return isDariRun(input) ? "harbor_dari:DariPi" : "pi";
  if (harness === "codex")
    return input.credentials?.provider === "custom"
      ? "harbor_gateway:GatewayCodex"
      : "harbor_gateway:SelfBenchCodex";
  return harness;
}

function gatewayRouted(
  input: EvaluationInput,
  harness: Harness,
  env: NodeJS.ProcessEnv,
  connection: GatewayConnection,
): SolverTrial {
  const child = { ...env };
  for (const name of MODEL_VARIABLES) delete child[name];
  const { requestModel, key } = connection;
  const extraAllowedHosts = [connection.host];
  if (harness === "claude-code") {
    // With a base URL, Harbor sends the model name as given and pins every Claude tier to it.
    Object.assign(child, { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: connection.anthropicBase });
    return {
      model: requestModel,
      agent: "harbor_gateway:SelfBenchClaudeCode",
      agentArguments: thinkingArguments(harness, input.thinking),
      child,
      extraAllowedHosts,
    };
  }
  if (harness === "pi") {
    // Pi reaches the gateway through a provider written to its models.json (piGatewayModels).
    child.OPENAI_API_KEY = key;
    return {
      model: `${PI_GATEWAY_PROVIDER}/${requestModel}`,
      agent: "harbor_gateway:GatewayPi",
      agentArguments: [
        "--agent-kwarg",
        `models_json=${JSON.stringify(piGatewayModels(input, connection))}`,
      ],
      child,
      extraAllowedHosts,
    };
  }
  Object.assign(child, {
    OPENAI_API_KEY: key,
    OPENAI_BASE_URL: connection.openAiBase,
    OPENAI_API_BASE: connection.openAiBase,
  });
  return {
    // Harbor's OpenAI-compatible adapters keep only the last segment of a model name; Codex's
    // GatewayCodex restores the full id, and the others take `openai/` as their provider.
    model: `openai/${requestModel}`,
    agent: harness === "codex" ? "harbor_gateway:GatewayCodex" : harness,
    agentArguments: harness === "codex" ? thinkingArguments(harness, input.thinking) : [],
    child,
    extraAllowedHosts,
  };
}

/** The part of a model's catalog entry a gateway trial's models.json keeps. */
interface CatalogEntry {
  name: string;
  input: readonly string[];
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * Pi's models.json for a gateway trial: one provider at the gateway's Chat Completions endpoint,
 * keyed by OPENAI_API_KEY, with the one model the key serves. Pi sends no thinking level (the
 * gateway pins it), but takes its context window and output limit from Pi's catalog entry for the
 * model, or else from a gateway listing's, so it compacts and caps replies as it would directly.
 */
export function piGatewayModels(
  input: Pick<EvaluationInput, "credentials" | "modelName">,
  connection: Pick<GatewayConnection, "openAiBase" | "requestModel">,
): object {
  const model = gatewayModelId(input);
  const slash = model.indexOf("/");
  const provider = model.slice(0, slash);
  const id = model.slice(slash + 1);
  const catalog = getBuiltinModel(provider as never, id as never) as unknown as
    | CatalogEntry
    | undefined;
  const known = catalog ?? (isGateway(provider) ? listedModel(provider, id)?.pi : undefined);
  return {
    providers: {
      [PI_GATEWAY_PROVIDER]: {
        baseUrl: connection.openAiBase,
        api: "openai-completions",
        apiKey: "$OPENAI_API_KEY",
        models: [
          {
            id: connection.requestModel,
            ...(known
              ? {
                  name: known.name,
                  input: known.input,
                  ...(known.contextWindow ? { contextWindow: known.contextWindow } : {}),
                  ...(known.maxTokens ? { maxTokens: known.maxTokens } : {}),
                }
              : {}),
          },
        ],
      },
    },
  };
}
