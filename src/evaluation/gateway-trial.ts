import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ThinkingLevel } from "../contracts/models.js";
import type { GatewayConnection } from "../gateway/connection.js";
import type { PinnedThinking } from "../gateway/trial-key.js";
import { gateways, isGateway, listedModel, modelApiKeyVariable } from "../gateways/index.js";
import { type CompatibleEndpoint, compatibleEndpoint } from "./compatible-endpoints.js";
import { isDariRun } from "./dari/cost.js";
import { thinkingArguments } from "./models.js";
import { refuseTrial } from "./refusal.js";
import type { EvaluationInput, Harness } from "./types.js";

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
 * the model, holds the key, and records each call's cost. Routes that stay direct: a sign-in (the
 * gateway serves no subscriptions yet), Dari's router (dari/cost.ts prices it by its own response),
 * a Meta key until DIRECT_API_KEY_PROVIDERS drops it (the gateway's Meta provider is unreleased),
 * and Muse Code on a Meta key (its CLI takes bare model ids, which the gateway's `dari/model/` ids
 * are not, so it keeps Meta's endpoint).
 */
export type TrialRoute = "gateway" | "direct";

/**
 * Providers whose API keys stay on their direct route. Meta stays here until the gateway's built-in
 * Meta provider (dari-mono #1052, combined with #1054) ships in a published @mupt-ai/dari-gateway:
 * until then the gateway cannot serve Meta, so those trials would fail there. Remove "meta" with
 * that release to route Meta API-key trials through the gateway like every other key.
 */
export const DIRECT_API_KEY_PROVIDERS: ReadonlySet<string> = new Set(["meta"]);

export function trialRoute(
  input: Pick<EvaluationInput, "credentials" | "modelName">,
  harness: Harness,
  auth = input.credentials?.auth ?? "api-key",
  directProviders: ReadonlySet<string> = DIRECT_API_KEY_PROVIDERS,
): TrialRoute {
  if (auth !== "api-key" || isDariRun(input)) return "direct";
  const provider = input.credentials?.provider ?? "";
  if (directProviders.has(provider)) return "direct";
  if (harness === "muse-code" && provider === "meta") return "direct";
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
  const endpoint = compatibleEndpoint(provider, harness);
  if (endpoint) return endpointTrial(endpoint, input, harness, model, env);
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

/** A direct key at a provider endpoint that speaks the harness's protocol (compatible-endpoints.ts). */
function endpointTrial(
  endpoint: CompatibleEndpoint,
  input: EvaluationInput,
  harness: Harness,
  model: string,
  env: NodeJS.ProcessEnv,
): SolverTrial {
  const provider = input.credentials?.provider ?? "";
  const keyVariable = modelApiKeyVariable(provider);
  const key = env[keyVariable];
  if (!key) throw refuseTrial("Model credential is unavailable");
  const child = { ...env };
  delete child[keyVariable];
  const modelId = model.slice(provider.length + 1);
  if (harness === "claude-code") {
    Object.assign(child, { ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_BASE_URL: endpoint.anthropicBase });
  } else {
    Object.assign(child, {
      OPENAI_API_KEY: key,
      OPENAI_BASE_URL: endpoint.openAiBase,
      OPENAI_API_BASE: endpoint.openAiBase,
    });
  }
  return {
    model: harness === "claude-code" ? modelId : `openai/${modelId}`,
    agent: harness === "codex" ? "harbor_gateway:GatewayCodex" : directAgent(harness, input),
    // Meta recommends Responses for Pi: Chat Completions drops reasoning between turns.
    agentArguments: [
      ...thinkingArguments(harness, input.thinking),
      ...(harness === "pi" ? ["--agent-kwarg", "model_api=openai-responses"] : []),
    ],
    child,
    extraAllowedHosts: directHosts(provider, {}),
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
