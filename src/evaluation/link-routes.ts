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
 * Harnesses a model a Dari connection serves runs on: one only a Claude or Muse plan serves, that
 * plan's agent alone (Dari refuses it to any other app); any other, every harness that can call an
 * endpoint, since Dari serves each model in Chat Completions, Responses and Messages alike, and
 * Muse Code too for a Meta model (a Meta key's).
 */
const linkHarnesses = (id: string, only: DariLinkOnly | undefined): Harness[] =>
  only ? [only] : [...openHarnesses, ...(id.startsWith("meta/") ? (["muse-code"] as const) : [])];

/**
 * A model on a Dari connection: the first of its routes the connection serves by Dari's id, with
 * that route's levels and prices. Its vendor's id comes first (`openai/gpt-6-sol`, which a plan or
 * the vendor's key serves), from its native route or, for a model only gateways list, from each
 * gateway's id for it, as the gateway spells the vendor and as the catalog does (`meta/` and
 * `meta-llama/`); then each gateway's own (`openrouter/openai/gpt-6-sol`, a gateway key's).
 */
function dariLinkRoute(
  model: CatalogModel,
  models: DariLinkModels | undefined,
): CatalogModel | undefined {
  if (model.provider === "dari-link") {
    const served = linkedModel(models, model.model);
    return served ? { ...model, harnesses: linkHarnesses(model.model, served.only) } : undefined;
  }
  const routes = modelRoutes(model).filter(
    (route) => route.provider !== "custom" && route.provider !== "dari",
  );
  const candidates = [
    ...routes.flatMap((route) =>
      isGateway(route.provider)
        ? [route.model, catalogModelId(route.provider, route.model)].map((id) => ({ route, id }))
        : [{ route, id: `${route.provider}/${route.model}` }],
    ),
    ...routes
      .filter((route) => isGateway(route.provider))
      .map((route) => ({ route, id: `${route.provider}/${route.model}` })),
  ];
  for (const { route, id } of candidates) {
    const served = linkedModel(models, id);
    if (served)
      return {
        ...route,
        provider: "dari-link",
        model: id,
        harnesses: linkHarnesses(id, served.only),
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
