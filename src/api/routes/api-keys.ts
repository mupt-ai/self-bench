import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { API_KEY_SCOPES, type ApiKeyStore } from "../../db/api-keys.js";
import type { User } from "../../db/users.js";
import { readBody, sendJson, trustedMutation } from "../http.js";

const listRoute = /^\/api\/api-keys$/;
const itemRoute = /^\/api\/api-keys\/(\d{1,18})$/;
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scope: z.enum(API_KEY_SCOPES).default("write"),
  })
  .strict();

export interface ApiKeyRoutesOptions {
  readonly keys: ApiKeyStore;
  readonly publicUrl: string;
}

export interface ApiKeyRoutes {
  /** Answers /api/api-keys for a signed-in user. True when the response has been sent. */
  handle(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    user: User,
  ): Promise<boolean>;
}

/**
 * Personal API keys. Listing works from any session; minting and revoking require a browser
 * session, so a leaked key cannot be used to issue further keys.
 */
export function createApiKeyRoutes(options: ApiKeyRoutesOptions): ApiKeyRoutes {
  const { keys } = options;
  return {
    async handle(request, url, response, user) {
      const list = listRoute.test(url.pathname);
      const item = itemRoute.exec(url.pathname);
      if (!list && !item) return false;
      response.setHeader("cache-control", "no-store");
      if (list && request.method === "GET") {
        sendJson(response, 200, { keys: await keys.list(user.id) });
        return true;
      }
      const mutation = (list && request.method === "POST") || (item && request.method === "DELETE");
      if (!mutation) return false;
      if (user.apiKey) {
        sendJson(response, 403, { error: "API keys are managed from a signed-in browser session" });
        return true;
      }
      if (!trustedMutation(request, options.publicUrl, user)) {
        sendJson(response, 403, { error: "Same-origin JSON request required" });
        return true;
      }
      if (list) {
        const parsed = createSchema.safeParse(
          JSON.parse((await readBody(request, 4 * 1024)).toString("utf8") || "{}"),
        );
        if (!parsed.success) {
          sendJson(response, 400, {
            error: "name is required (up to 80 characters); scope is read or write",
          });
          return true;
        }
        sendJson(response, 201, await keys.create(user.id, parsed.data));
        return true;
      }
      const revoked = await keys.revoke(user.id, Number(item?.[1]));
      sendJson(
        response,
        revoked ? 200 : 404,
        revoked ? { ok: true } : { error: "API key not found" },
      );
      return true;
    },
  };
}
