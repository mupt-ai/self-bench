import type { ThinkingLevel } from "../contracts/models.js";
import type { CredentialInfo } from "../db/credentials.js";
import type { GatewayConnection } from "../gateway/connection.js";
import type { PinnedThinking } from "../gateway/trial-key.js";
import type { createGatewayUsageStore } from "../gateway/usage-store.js";
import { catalogEntry } from "../gateways/catalog.js";
import { gateways } from "../gateways/index.js";
import type { SandboxCallback } from "../generation/pipeline/sandbox-job.js";
import { isDariRun } from "./dari/cost.js";
import { thinkingArguments } from "./models.js";
import { refuseTrial } from "./refusal.js";
import type { EvaluationInput, EvaluationRun, EvaluationTrial, Harness } from "./types.js";

/**
 * How a trial's agent reaches its model. Every API key and ChatGPT or Claude sign-in goes through
 * SelfBench's gateway, which pins the model, holds the key or plan, and records each call's cost.
 * Routes that stay direct: Dari's router on Pi (the gateway reads a reported cost only from
 * OpenRouter and Vercel, so dari/cost.ts prices it by its own response), and Muse Code on a Meta
 * sign-in or key (its sign-in key is minted inside its CLI, and its CLI reads its model list from
 * its endpoint's origin and takes the endpoint only from its own settings).
 */
export type TrialRoute = "gateway" | "direct";

export function trialRoute(
  input: Pick<EvaluationInput, "credentials" | "modelName">,
  harness: Harness,
  auth: CredentialInfo["auth"] = input.credentials?.auth ?? "api-key",
): TrialRoute {
  if (auth === "muse-login" || (harness === "pi" && isDariRun(input))) return "direct";
  return harness === "muse-code" && input.credentials?.provider === "meta" ? "direct" : "gateway";
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
 * for the one model the key serves. Direct, Muse Code keeps its Meta sign-in or key, and Pi Dari's
 * router endpoint.
 */
export function gatewayTrial(
  input: EvaluationInput,
  harness: Harness,
  model: string,
  env: NodeJS.ProcessEnv,
  connection?: GatewayConnection,
): SolverTrial {
  if (trialRoute(input, harness) === "gateway") {
    if (!connection) throw refuseTrial("Model gateway connection is missing");
    return gatewayRouted(input, harness, env, connection);
  }
  const muse = harness === "muse-code";
  const host = (url: string | undefined) => (url ? [new URL(url).hostname] : []);
  return {
    model: input.credentials?.provider === "dari" ? "openai/dari/routing" : model,
    agent: muse ? "harbor_muse:SelfBenchMuseCode" : "harbor_dari:DariPi",
    // Harbor needs an explicit API style for Dari's Chat Completions endpoint.
    agentArguments: [
      ...thinkingArguments(harness, input.thinking),
      ...(muse ? [] : ["--agent-kwarg", "model_api=openai-completions"]),
    ],
    child: { ...env },
    extraAllowedHosts: muse ? ["api.meta.ai"] : host(env.OPENAI_BASE_URL),
  };
}

/**
 * The hosts a trial's sandbox may reach: its model's, and the gateway's when a judge calls it, which
 * runs in the sandbox or its verifier on any route.
 */
export function allowedHosts(
  solver: Pick<SolverTrial, "extraAllowedHosts">,
  judge?: Pick<GatewayConnection, "host">,
): string[] {
  return [...new Set([...solver.extraAllowedHosts, ...(judge ? [judge.host] : [])])];
}

function gatewayRouted(
  input: EvaluationInput,
  harness: Harness,
  env: NodeJS.ProcessEnv,
  connection: GatewayConnection,
): SolverTrial {
  const child = { ...env };
  for (const name of MODEL_VARIABLES) delete child[name];
  const { key } = connection;
  const requestModel = gatewayRequestModel(input);
  const extraAllowedHosts = [connection.host];
  if (harness === "claude-code") {
    // With a base URL, Harbor sends the model name as given and pins every Claude tier to it.
    Object.assign(child, { ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: connection.anthropicBase });
    return {
      model: requestModel,
      agent: "harbor_gateway:SelfBenchClaudeCode",
      agentArguments: [
        ...thinkingArguments(harness, input.thinking),
        ...(input.subagent
          ? ["--agent-kwarg", `subagent_model=dari/model/${input.subagent.model}`]
          : []),
      ],
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

/**
 * Pi's models.json for a gateway trial: one provider at the gateway's Chat Completions endpoint,
 * keyed by OPENAI_API_KEY, with the one model the key serves. Pi sends no thinking level (the
 * gateway pins it), but takes its context window and output limit from the model catalog's entry
 * for the model, so it compacts and caps replies as it would directly.
 */
export function piGatewayModels(
  input: Pick<EvaluationInput, "credentials" | "modelName">,
  connection: Pick<GatewayConnection, "openAiBase">,
): object {
  const known = catalogEntry(gatewayModelId(input));
  return {
    providers: {
      [PI_GATEWAY_PROVIDER]: {
        baseUrl: connection.openAiBase,
        api: "openai-completions",
        apiKey: "$OPENAI_API_KEY",
        models: [
          {
            id: gatewayRequestModel(input),
            ...(known
              ? {
                  name: known.name,
                  input: known.input_modalities.includes("image") ? ["text", "image"] : ["text"],
                  ...(known.context_window ? { contextWindow: known.context_window } : {}),
                  ...(known.max_output_tokens ? { maxTokens: known.max_output_tokens } : {}),
                }
              : {}),
          },
        ],
      },
    },
  };
}

/** The tag the gateway records a trial's calls under, unique within its organization. */
export function gatewayTrialTag(run: Pick<EvaluationRun, "id">, index: number): string {
  return `${run.id}/${index}`;
}

/** SelfBench's model gateway, which a trial's agent and judge reach their models through. */
export interface TrialGateway {
  /** The API's address as sandboxes reach it, and the secret its trial keys are signed with. */
  readonly api: SandboxCallback;
  /** What the gateway recorded each trial's calls cost. */
  readonly usage: Pick<ReturnType<typeof createGatewayUsageStore>, "trialCost">;
}

/**
 * What the gateway recorded the trial's calls cost, which replaces any estimate: the provider's
 * own charge where it reports one (OpenRouter, Vercel AI Gateway), else the model's list price,
 * which on a sign-in's plan bills nothing. A trial with a call neither priced has no gateway cost;
 * nor does one that made no call.
 */
export async function gatewayTrialCost(
  gateway: TrialGateway,
  orgId: number,
  run: EvaluationRun,
  index: number,
  auth: CredentialInfo["auth"],
): Promise<Pick<EvaluationTrial, "apiCostUsd" | "billedCostUsd" | "costSource">> {
  const cost = await gateway.usage.trialCost(orgId, gatewayTrialTag(run, index));
  if (!cost?.complete) return {};
  return {
    apiCostUsd: cost.costUsd,
    // A secondary credential can be a sign-in even when the parent uses an API key.
    ...(auth === "api-key" && !run.subagent ? { billedCostUsd: cost.costUsd } : {}),
    costSource: "gateway",
  };
}
