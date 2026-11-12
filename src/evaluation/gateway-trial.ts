import type { ThinkingLevel } from "../contracts/models.js";
import type { CredentialInfo } from "../db/credentials.js";
import type { GatewayConnection } from "../gateway/connection.js";
import { registryModel } from "../gateway/model-config.js";
import type { CustomEndpointApi, PinnedThinking, TrialKey } from "../gateway/trial-key.js";
import { catalogEntry } from "../gateways/catalog.js";
import { gateways } from "../gateways/index.js";
import { isDariRun } from "./dari/cost.js";
import { thinkingArguments } from "./models.js";
import { refuseTrial } from "./refusal.js";
import type { EvaluationInput, EvaluationRun, Harness } from "./types.js";

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

/**
 * The API a custom endpoint is called with for the harness: its own protocol, so the endpoint sees
 * the calls the harness would make of it directly. Others take Chat Completions, and a trial on
 * any other credential names none (a key's `api` marks a custom endpoint's, as mount.ts reads it).
 */
export function customEndpointApi(
  input: Pick<EvaluationInput, "credentials">,
  harness: Harness,
): { api?: CustomEndpointApi } {
  if (input.credentials?.provider !== "custom") return {};
  if (harness === "codex") return { api: "openai-responses" };
  return harness === "claude-code" ? { api: "anthropic-messages" } : {};
}

/**
 * Whether the trial's endpoint picks each call's reasoning effort, so the gateway sends none
 * (TrialKey.endpointEffort): Dari's router always, and a custom endpoint driven by Codex, which
 * asks a model it has no metadata for for effort "none". A custom endpoint takes no chosen level.
 * On one whose model Pi's registry knows (Fire Pass, Baseten), every call is served at the
 * model's own default (platform.ts), so no harness's effort is sent: Claude Code's may be one the
 * model does not list (GLM 5.3 has no `medium`).
 */
export function endpointPicksEffort(
  input: Pick<EvaluationInput, "credentials" | "modelName">,
  harness: Harness,
  endpoint?: string | null,
): boolean {
  const provider = input.credentials?.provider;
  if (provider === "dari") return true;
  if (provider !== "custom") return false;
  return harness === "codex" || (!!endpoint && !!registryModel(endpoint, gatewayModelId(input)));
}

/** The name a request carries for the gateway's model `id`, which the gateway serves exactly. */
function gatewayRequestName(id: string): string {
  return `dari/model/${id}`;
}

/** The model name a gateway trial's requests carry, which the gateway serves exactly. */
export function gatewayRequestModel(input: Pick<EvaluationInput, "credentials" | "modelName">) {
  return gatewayRequestName(gatewayModelId(input));
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

/**
 * A run's subagent model as its trial key names it: the gateway's model id, the credential that
 * serves it, and the level it is pinned to. Unlike the run's own model, it is pinned on every
 * harness, Claude Code too: the gateway drops whatever level a call for it asks for (mount.ts).
 */
export function subagentKey(
  subagent: NonNullable<EvaluationInput["subagent"]>,
): NonNullable<TrialKey["subagent"]> {
  const { model, credentialId, thinking } = subagent;
  return {
    model,
    credentialId,
    ...(thinking && thinking !== "default" ? { thinking } : {}),
  };
}

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

/** The `--agent-kwarg` that names a run's subagent model to its harness's adapter (harbor_gateway.py). */
function subagentArguments(input: Pick<EvaluationInput, "subagent">): string[] {
  return input.subagent
    ? ["--agent-kwarg", `subagent_model=${gatewayRequestName(input.subagent.model)}`]
    : [];
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
      // Its subagents ask the gateway for the subagent model (SelfBenchClaudeCode).
      agentArguments: [...thinkingArguments(harness, input.thinking), ...subagentArguments(input)],
      child,
      extraAllowedHosts,
    };
  }
  Object.assign(child, {
    OPENAI_API_KEY: key,
    OPENAI_BASE_URL: connection.openAiBase,
    OPENAI_API_BASE: connection.openAiBase,
  });
  // Harbor reads `openai/` as the provider and sends the rest, the gateway's model id, as given.
  const model = `openai/${requestModel}`;
  if (harness === "pi") {
    // Pi reaches the gateway as Harbor's custom endpoint, whose models.json entry GatewayPi
    // completes with the model's details.
    return {
      model,
      agent: "harbor_gateway:GatewayPi",
      agentArguments: [
        "--agent-kwarg",
        "model_api=openai-completions",
        "--agent-kwarg",
        `model_details=${JSON.stringify(piModelDetails(input))}`,
      ],
      child,
      extraAllowedHosts,
    };
  }
  if (harness === "codex") {
    return {
      model,
      agent: "harbor_gateway:GatewayCodex",
      agentArguments: [
        ...thinkingArguments(harness, input.thinking),
        // An endpoint without an image model refuses a conversation holding a viewed image.
        ...(acceptsImages(input) ? [] : ["--agent-kwarg", "view_image=false"]),
        // Its subagents ask the gateway for the subagent model (GatewayCodex).
        ...subagentArguments(input),
      ],
      child,
      extraAllowedHosts,
    };
  }
  return { model, agent: harness, agentArguments: [], child, extraAllowedHosts };
}

/**
 * Whether the trial's model reads images, as the model catalog lists it. A custom endpoint's
 * models are unknown, so it is taken not to: a router may have no model that does.
 */
export function acceptsImages(
  input: Pick<EvaluationInput, "credentials" | "modelName" | "subagent">,
) {
  // A harness's subagents share its tools, so both of a run's models must read images.
  const ids = [gatewayModelId(input), ...(input.subagent ? [input.subagent.model] : [])];
  return ids.every((id) => catalogEntry(id)?.input_modalities.includes("image") === true);
}

/**
 * What Pi's models.json says of a gateway trial's model beyond its id, from the model catalog's
 * entry for it: Pi sends no thinking level (the gateway pins it), but takes its context window and
 * output limit from here, so it compacts and caps replies as it would directly.
 */
export function piModelDetails(input: Pick<EvaluationInput, "credentials" | "modelName">): object {
  const known = catalogEntry(gatewayModelId(input));
  if (!known) return {};
  return {
    name: known.name,
    input: acceptsImages(input) ? ["text", "image"] : ["text"],
    ...(known.context_window ? { contextWindow: known.context_window } : {}),
    ...(known.max_output_tokens ? { maxTokens: known.max_output_tokens } : {}),
  };
}

/** The tag the gateway records a trial's calls under, unique within its organization. */
export function gatewayTrialTag(run: Pick<EvaluationRun, "id">, index: number): string {
  return `${run.id}/${index}`;
}
