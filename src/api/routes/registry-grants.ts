import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  type CustomerGrant,
  GrantRefusal,
  type RegistryGrantStore,
} from "../../db/registry-grants.js";
import { proxiedImage, REGISTRY_USERNAME } from "../../sandbox/registry-grant.js";
import { readBody, sendJson } from "../http.js";

const MAX_DAYS = 365;
const createSchema = z.strictObject({
  label: z.string().trim().min(1).max(200),
  taskIds: z.array(z.number().int().positive()).min(1).max(1000),
  /** Also grant the verifier images, which hold each task's tests. Off unless asked for. */
  withVerifier: z.boolean().default(false),
  days: z.number().int().min(1).max(MAX_DAYS).default(30),
});
const grantRoute = /^\/v1\/registry-grants\/([0-9a-f-]{36})\/revoke$/;

/**
 * `/v1/registry-grants`: the operator issues, lists and revokes customers' pull grants. Only the
 * API token may, never a signed-in user. `origin` is the API's public URL, the registry customers
 * log in to.
 */
export async function handleRegistryGrantRoute(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  context: { store: RegistryGrantStore; origin: string; operator: boolean },
): Promise<boolean> {
  if (url.pathname !== "/v1/registry-grants" && !url.pathname.startsWith("/v1/registry-grants/"))
    return false;
  if (!context.operator) {
    sendJson(response, 403, { error: "registry grants need the API token" });
    return true;
  }
  const { store, origin } = context;
  if (request.method === "GET" && url.pathname === "/v1/registry-grants") {
    sendJson(response, 200, { grants: (await store.list()).map(describe) });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/v1/registry-grants") {
    let input: z.infer<typeof createSchema>;
    try {
      input = createSchema.parse(
        JSON.parse((await readBody(request, 64 * 1024)).toString() || "{}"),
      );
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof z.ZodError ? z.prettifyError(error) : "invalid JSON",
      });
      return true;
    }
    try {
      const { grant, password } = await store.create({
        label: input.label,
        taskIds: input.taskIds,
        withVerifier: input.withVerifier,
        expiresAt: new Date(Date.now() + input.days * 24 * 60 * 60 * 1000),
      });
      const registry = new URL(origin).host;
      sendJson(response, 201, {
        ...describe(grant),
        // Shown only now; the API keeps no way to recover it.
        login: { registry, username: REGISTRY_USERNAME, password },
        pulls: grant.images.map((image) => proxiedImage(origin, image)),
      });
    } catch (error) {
      if (!(error instanceof GrantRefusal)) throw error;
      sendJson(response, 400, { error: error.message });
    }
    return true;
  }
  const revoke = request.method === "POST" ? grantRoute.exec(url.pathname) : null;
  if (revoke?.[1]) {
    const revoked = await store.revoke(revoke[1]);
    sendJson(
      response,
      revoked ? 200 : 404,
      revoked ? { revoked: true } : { error: "no live grant" },
    );
    return true;
  }
  sendJson(response, 404, { error: "not found" });
  return true;
}

function describe(grant: CustomerGrant) {
  return {
    id: grant.id,
    label: grant.label,
    taskIds: grant.taskIds,
    withVerifier: grant.withVerifier,
    images: grant.images.length,
    createdAt: grant.createdAt.toISOString(),
    expiresAt: grant.expiresAt.toISOString(),
    revokedAt: grant.revokedAt?.toISOString() ?? null,
  };
}
