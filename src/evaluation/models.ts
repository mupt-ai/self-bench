import type { ThinkingLevel } from "../contracts/models.js";
import type { CredentialInfo } from "../db/credentials.js";
import { type GatewayId, gatewayIds, gatewayModelId, isGateway } from "../gateways/index.js";
import { type CatalogModel, withReferencePricing } from "./catalog.js";

export const harnessIds = ["codex", "claude-code", "pi", "mini-swe-agent", "terminus-2"] as const;
export type Harness = (typeof harnessIds)[number];
export const harnessLabels: Record<Harness, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  pi: "Pi",
  "mini-swe-agent": "Mini-SWE-Agent",
  "terminus-2": "Terminus 2",
};
export const harnessOptions = harnessIds.map((id) => ({ id, label: harnessLabels[id] }));

export function evaluationTaskKey(runId: string, taskId: string): string {
  return JSON.stringify([runId, taskId]);
}

/** A subscription sign-in drives only its own vendor's CLI; API keys drive any harness. */
const signInHarnesses: Record<CredentialInfo["auth"], Harness | undefined> = {
  "api-key": undefined,
  "codex-login": "codex",
  "claude-login": "claude-code",
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

/** Harnesses a direct provider key can drive; only gateways are remapped for the rest. */
const providerHarnesses: Partial<Record<CatalogModel["provider"], Harness[]>> = {
  openai: ["codex", "pi", "mini-swe-agent", "terminus-2"],
  anthropic: ["claude-code", "pi", "mini-swe-agent", "terminus-2"],
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
              harnesses: [...harnessIds],
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

/** The levels a route offers its harnesses; a model's own levels until a credential is chosen. */
export function thinkingOptions(model: CatalogModel, harnesses: Harness[]): ThinkingLevel[] {
  if (harnesses.some((harness) => harness === "mini-swe-agent" || harness === "terminus-2"))
    return ["default"];
  // Custom endpoints are typed in by the user; the catalog only describes its own models.
  const levels = (model.provider === "custom" ? undefined : model.thinking)?.filter(
    (level) => !harnesses.includes("pi") || level !== "max",
  );
  return levels?.length ? levels : ["default"];
}

/** The level a row runs at when none is chosen: high where offered, else the first offered. */
export function defaultThinking(levels: readonly ThinkingLevel[]): ThinkingLevel {
  return levels.includes("high") ? "high" : (levels[0] ?? "default");
}

export function thinkingArguments(harness: Harness, level?: ThinkingLevel): string[] {
  if (!level || level === "default") return [];
  const name = harness === "pi" ? "thinking" : "reasoning_effort";
  const value = harness === "codex" && level === "off" ? "none" : level;
  return ["--agent-kwarg", `${name}=${value}`];
}
