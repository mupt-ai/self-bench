import type { ResolvedRouter } from "@mupt-ai/dari-gateway";
import { HttpError } from "@mupt-ai/dari-gateway/http/errors";
import { modelConfig } from "./model-config.js";
import type { GatewayModelConfig, GatewayModelPrice, SelfBenchGatewayDeps } from "./platform.js";
import type { PinnedThinking, TrialKey } from "./trial-key.js";

/** One model a trial key serves, as the router is told of it. */
export interface RouterModel {
  /** The gateway's id for it, `provider/model`. */
  readonly model: string;
  readonly config?: GatewayModelConfig | undefined;
  readonly price?: GatewayModelPrice | undefined;
  /** The one level it is served at, whatever level a call asks for or omits. */
  readonly pinned?: PinnedThinking | undefined;
}

/**
 * A key's subagent model: described and priced as a model of its own, on its own credential, and
 * pinned to its own level. None of the trial's own model's settings are its.
 */
export async function subagentRouterModel(
  deps: SelfBenchGatewayDeps,
  key: TrialKey,
): Promise<RouterModel | undefined> {
  const { subagent } = key;
  if (!subagent) return undefined;
  const credential = await deps.credentials.find(key.orgId, subagent.credentialId);
  if (!credential)
    throw new HttpError(401, "The subagent model's credential is unavailable.", "invalid_api_key");
  const { model, thinking: pinned } = subagent;
  const described = {
    orgId: key.orgId,
    model,
    ...(pinned ? { thinking: pinned } : {}),
    tags: key.tags,
    expiresAt: key.expiresAt,
  };
  return {
    model,
    config: modelConfig(deps, described, credential),
    price: deps.modelPrice?.(model),
    pinned,
  };
}

/** The router's per-model tables for the models a key serves; a table no model fills is left out. */
export function routerTables(
  models: readonly RouterModel[],
): Pick<ResolvedRouter, "model_configs" | "model_prices" | "model_thinking_levels"> {
  const table = <Value>(of: (model: RouterModel) => Value | undefined) =>
    Object.fromEntries(
      models.flatMap((model) => {
        const value = of(model);
        return value === undefined ? [] : [[model.model, value] as const];
      }),
    );
  const configs = table((model) => model.config);
  const prices = table((model) => model.price);
  const levels = table((model) => (model.pinned ? [model.pinned] : undefined));
  return {
    ...(Object.keys(configs).length ? { model_configs: configs } : {}),
    ...(Object.keys(prices).length ? { model_prices: prices } : {}),
    ...(Object.keys(levels).length ? { model_thinking_levels: levels } : {}),
  };
}
