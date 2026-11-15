/**
 * What kind of thing a public setting measures, for the filters on a results page: a model as its
 * vendor serves it, or a router that picks models for each request (Dari Router, Shift, a
 * Fireworks router, any custom endpoint).
 */
export type SettingKind = "model" | "router";

export const SETTING_KINDS: readonly { kind: SettingKind; label: string }[] = [
  { kind: "model", label: "Models" },
  { kind: "router", label: "Routers" },
];

/**
 * Catalog models that are routers, though served like any other model. Add a router here when one
 * joins the catalog; custom endpoints and Dari's own provider count as routers without a listing.
 */
const ROUTER_MODELS: ReadonlySet<string> = new Set(["dari/routing", "typesafe/jev-router"]);

const ROUTER_PROVIDERS: ReadonlySet<string> = new Set(["dari", "fireworks", "shift"]);

export function settingKind(setting: {
  custom: boolean;
  provider: string;
  model: { catalogId: string };
}): SettingKind {
  if (setting.custom) return "router";
  if (ROUTER_PROVIDERS.has(setting.provider)) return "router";
  if (ROUTER_MODELS.has(setting.model.catalogId)) return "router";
  return "model";
}
