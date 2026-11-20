import type { CredentialInfo } from "../db/credentials.js";
import {
  type DariLinkModels,
  type DariLinkOnly,
  linkedModel,
} from "../gateway/dari-link/connection.js";
import { catalogModelId, isGateway } from "../gateways/index.js";
import type { CatalogModel } from "./catalog.js";
import { type Harness, modelRoutes, openHarnesses, routeFor } from "./models.js";

// Routes on a Dari Link connection, which serves whatever models its grant lists.

/** What a credential's route needs of it: its kind, and a Dari connection's models. */
export type RouteCredential = Pick<CredentialInfo, "kind"> & { linkModels?: DariLinkModels };

/** The credential's route for the model: its provider's, or what its Dari connection serves. */
export function credentialRoute(
  model: CatalogModel,
  credential: RouteCredential,
): CatalogModel | undefined {
  return credential.kind === "dari-link"
    ? dariLinkRoute(model, credential.linkModels)
    : routeFor(model, credential.kind);
}

/**
 * The harnesses a model on a Dari connection runs on. A plan that serves only its vendor's agent
 * runs on that agent alone. Otherwise every harness that calls an endpoint can, and a Muse model
 * (`meta/muse-…`) adds Muse Code, the one agent that speaks Meta's Muse API.
 */
function linkHarnesses(id: string, only: DariLinkOnly | undefined): Harness[] {
  if (only) return [only];
  if (id.startsWith("meta/muse-")) return [...openHarnesses, "muse-code"];
  return [...openHarnesses];
}

/**
 * The names a vendor's plan or key serves a route by. A gateway route's model is named as the
 * gateway spells it and as the catalog does, since Dari spells a vendor either way
 * (`meta/llama-5`, `meta-llama/llama-5`).
 */
function vendorNames(route: CatalogModel): string[] {
  if (!isGateway(route.provider)) return [`${route.provider}/${route.model}`];
  return [route.model, catalogModelId(route.provider, route.model)];
}

/**
 * Each of the model's routes under each name Dari may know it by, in the order a connection is
 * matched: every vendor name first, so a plan or vendor key wins, then each gateway route's
 * gateway-prefixed name (`openrouter/openai/gpt-6-sol`), which a gateway key serves.
 */
function dariNames(model: CatalogModel): { route: CatalogModel; name: string }[] {
  const routes = modelRoutes(model).filter(
    (route) => route.provider !== "custom" && route.provider !== "dari",
  );
  const names: { route: CatalogModel; name: string }[] = [];
  for (const route of routes) for (const name of vendorNames(route)) names.push({ route, name });
  for (const route of routes)
    if (isGateway(route.provider)) names.push({ route, name: `${route.provider}/${route.model}` });
  return names;
}

/**
 * A model on a Dari connection: its first route and name that the connection serves. The route
 * keeps its levels and prices; its model becomes Dari's name for it.
 */
function dariLinkRoute(
  model: CatalogModel,
  models: DariLinkModels | undefined,
): CatalogModel | undefined {
  if (model.provider === "dari-link") {
    const served = linkedModel(models, model.model);
    return served ? { ...model, harnesses: linkHarnesses(model.model, served.only) } : undefined;
  }
  for (const { route, name } of dariNames(model)) {
    const served = linkedModel(models, name);
    if (served)
      return {
        ...route,
        provider: "dari-link",
        model: name,
        harnesses: linkHarnesses(name, served.only),
      };
  }
  return undefined;
}

/**
 * The models Dari connections serve that the catalog does not list (an OpenCode Go plan's GLM),
 * by Dari's id, each run only on its connection. A gateway key's prefix lists none: its gateway's
 * models are the catalog's.
 */
export function linkedCatalogModels(
  catalog: readonly CatalogModel[],
  credentials: readonly Pick<CredentialInfo, "kind" | "linkModels">[],
): CatalogModel[] {
  const extra = new Map<string, CatalogModel>();
  for (const credential of credentials) {
    if (credential.kind !== "dari-link" || !credential.linkModels) continue;
    const routed = new Set(
      catalog.flatMap((model) => dariLinkRoute(model, credential.linkModels)?.model ?? []),
    );
    for (const served of credential.linkModels.models)
      if (!routed.has(served.id) && !extra.has(served.id))
        extra.set(served.id, linkedCatalogModel(served));
  }
  return [...extra.values()];
}

/**
 * A model only this credential's Dari connection lists, by Dari's id: the catalog does not know
 * it, so it is described as the connection names it.
 */
export function linkedOnly(
  id: string,
  credential: Pick<CredentialInfo, "kind" | "linkModels"> | undefined,
): CatalogModel | undefined {
  if (credential?.kind !== "dari-link") return undefined;
  const served = credential.linkModels?.models.find((entry) => entry.id === id);
  return served && linkedCatalogModel(served);
}

/** A model only a Dari connection lists, as the catalog would describe it. */
function linkedCatalogModel(served: DariLinkModels["models"][number]): CatalogModel {
  return {
    id: served.id,
    provider: "dari-link",
    model: served.id,
    label: served.name ?? served.id,
    harnesses: linkHarnesses(served.id, served.only),
    source: "",
  };
}
