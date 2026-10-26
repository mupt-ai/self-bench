import type { ThinkingLevel } from "../contracts/models.js";
import type { CredentialInfo } from "../db/credentials.js";
import { type GatewayId, gatewayIds, gatewayModelId, isGateway } from "../gateways/index.js";
import { type CatalogModel, withReferencePricing } from "./catalog.js";

export const harnessIds = [
  "codex",
  "claude-code",
  "pi",
  "mini-swe-agent",
  "terminus-2",
  "muse-code",
] as const;
export type Harness = (typeof harnessIds)[number];

/** Every level but the provider default, as most Harbor adapters spell them ("none" for off). */
const reasoningEfforts = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
} as const satisfies Partial<Record<ThinkingLevel, string>>;

interface HarnessSpec {
  label: string;
  /** The Harbor agent argument a thinking level travels as. */
  thinkingArgument: string;
  /** The levels its Harbor adapter accepts, as that adapter spells them. */
  thinking: Partial<Record<ThinkingLevel, string>>;
  /** The one provider it speaks to, for a vendor's own CLI that no gateway can serve. */
  provider?: CatalogModel["provider"];
}

const harnessSpecs: Record<Harness, HarnessSpec> = {
  codex: { label: "Codex", thinkingArgument: "reasoning_effort", thinking: reasoningEfforts },
  "claude-code": {
    label: "Claude Code",
    thinkingArgument: "reasoning_effort",
    thinking: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  },
  pi: {
    label: "Pi",
    thinkingArgument: "thinking",
    thinking: {
      off: "off",
      minimal: "minimal",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    },
  },
  "mini-swe-agent": {
    label: "Mini-SWE-Agent",
    thinkingArgument: "reasoning_effort",
    thinking: reasoningEfforts,
  },
  "terminus-2": {
    label: "Terminus 2",
    thinkingArgument: "reasoning_effort",
    thinking: reasoningEfforts,
  },
  "muse-code": {
    label: "Muse Code",
    thinkingArgument: "reasoning_effort",
    thinking: reasoningEfforts,
    provider: "meta",
  },
};
export const harnessLabels = Object.fromEntries(
  harnessIds.map((id) => [id, harnessSpecs[id].label]),
) as Record<Harness, string>;
export const harnessOptions = harnessIds.map((id) => ({ id, label: harnessLabels[id] }));
/** Harnesses any OpenAI- or Anthropic-compatible endpoint can drive, gateways included. */
export const openHarnesses = harnessIds.filter((harness) => !harnessSpecs[harness].provider);

export function evaluationTaskKey(runId: string, taskId: string): string {
  return JSON.stringify([runId, taskId]);
}

/**
 * API keys drive any harness their route speaks. Claude and Meta sign-ins drive only their
 * vendor's CLI by rule; a ChatGPT sign-in only because Codex alone reads its auth.json.
 */
const signInHarnesses: Record<CredentialInfo["auth"], Harness | undefined> = {
  "api-key": undefined,
  "codex-login": "codex",
  "claude-login": "claude-code",
  "muse-login": "muse-code",
};

export function credentialRunsHarness(auth: CredentialInfo["auth"], harness: Harness): boolean {
  const only = signInHarnesses[auth];
  return !only || only === harness;
}

/** Why a credential's sign-in cannot run these harnesses, if it cannot. */
export function signInRefusal(
  auth: CredentialInfo["auth"],
  harnesses: readonly Harness[],
): string | undefined {
  const only = signInHarnesses[auth];
  return only && harnesses.some((harness) => harness !== only)
    ? `A ${harnessLabels[only]} sign-in can only run the ${harnessLabels[only]} harness`
    : undefined;
}

/**
 * Harnesses a direct provider key can drive: those that speak its API. OpenAI serves no
 * Anthropic Messages for Claude Code, and Anthropic no Responses for Codex; Meta serves both, so a
 * Meta key drives every harness through the gateway. Muse Code speaks only Meta's API.
 */
const providerHarnesses: Partial<Record<CatalogModel["provider"], Harness[]>> = {
  dari: ["pi"],
  openai: ["codex", "pi", "mini-swe-agent", "terminus-2"],
  anthropic: ["claude-code", "pi", "mini-swe-agent", "terminus-2"],
  meta: ["muse-code", ...openHarnesses],
};

/** Every credential route for a model: its native provider (if any) and each gateway serving it. */
export function modelRoutes(model: CatalogModel): CatalogModel[] {
  const native = providerHarnesses[model.provider] ?? providerHarnesses.openai ?? [];
  const { pricing: _pricing, ...gatewayModel } = model;
  return [
    ...(!isGateway(model.provider)
      ? [withReferencePricing({ ...model, harnesses: [...native] })]
      : []),
    ...(model.provider === "custom"
      ? [{ ...gatewayModel, provider: "openai" as const, harnesses: [...native] }]
      : []),
    ...gatewayIds.flatMap((gateway) => {
      const routed = gatewayRouteModel(model, gateway);
      const thinking = model.gatewayThinking?.[gateway];
      return routed
        ? [
            withReferencePricing({
              ...gatewayModel,
              provider: gateway,
              model: routed,
              harnesses: [...openHarnesses],
              ...(thinking ? { thinking } : {}),
            }),
          ]
        : [];
    }),
  ];
}

/** The id `gateway` receives for the model: its listed id, or a typed custom model id as is. */
function gatewayRouteModel(model: CatalogModel, gateway: GatewayId): string | undefined {
  if (model.provider === "custom") return model.model;
  if (model.gateways) return model.gateways[gateway];
  if (isGateway(model.provider)) return model.provider === gateway ? model.model : undefined;
  return gatewayModelId(gateway, `${model.provider}/${model.model}`);
}

export function routeFor(model: CatalogModel, provider: string) {
  return modelRoutes(model).find((route) => route.provider === provider);
}

/** The harnesses some credential runs the model on, for a row whose credential is unchosen. */
export function modelHarnesses(model: CatalogModel): Harness[] {
  const routed = new Set(modelRoutes(model).flatMap((route) => route.harnesses));
  return harnessIds.filter((harness) => routed.has(harness));
}

/**
 * The levels a route offers its harnesses: the model's own that every harness accepts, or the
 * model's own until a credential is chosen.
 */
export function thinkingOptions(model: CatalogModel, harnesses: Harness[]): ThinkingLevel[] {
  // Custom endpoints are typed in by the user; the catalog only describes its own models.
  const levels = (model.provider === "custom" ? undefined : model.thinking)?.filter((level) =>
    harnesses.every((harness) => level in harnessSpecs[harness].thinking),
  );
  return levels?.length ? levels : ["default"];
}

/** The level a row runs at when none is chosen: high where offered, else the first offered. */
export function defaultThinking(levels: readonly ThinkingLevel[]): ThinkingLevel {
  return levels.includes("high") ? "high" : (levels[0] ?? "default");
}

export function thinkingArguments(harness: Harness, level?: ThinkingLevel): string[] {
  const { thinkingArgument, thinking } = harnessSpecs[harness];
  const value = level && thinking[level];
  return value ? ["--agent-kwarg", `${thinkingArgument}=${value}`] : [];
}
