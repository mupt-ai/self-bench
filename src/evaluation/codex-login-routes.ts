import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { readBody, sendJson } from "../api/http.js";
import type { User } from "../auth/users.js";
import { tenantFor } from "../site/tenant.js";
import { codexLogins } from "./codex-login.js";
import { RecordStoreError } from "./encrypted-records.js";
import type { EvaluationRoutesOptions } from "./routes.js";

const pattern =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/credentials\/codex-login(?:\/([a-f0-9-]{36})(?:\/(complete|cancel))?)?$/;
const startSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();

export async function codexLoginRoutes(
  options: EvaluationRoutesOptions,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
) {
  const match = pattern.exec(url.pathname);
  if (!match) return false;
  response.setHeader("cache-control", "no-store");
  const org = await tenantFor(options.users, user, match[1] ?? "");
  if (!org) {
    sendJson(response, 404, { error: "Organization not found" });
    return true;
  }
  if (
    org.role !== "admin" ||
    (request.method !== "GET" &&
      (request.method !== "POST" ||
        request.headers.origin !== new URL(options.publicUrl).origin ||
        !request.headers["content-type"]?.startsWith("application/json")))
  ) {
    sendJson(response, 403, { error: "Organization admin and same-origin JSON request required" });
    return true;
  }
  const logins = options.codexLogins ?? codexLogins;
  try {
    if (!options.records) throw new RecordStoreError(503);
    const id = match[2];
    const action = match[3];
    if (request.method === "GET" && id && !action) {
      sendJson(response, 200, logins.status(org.id, user.id, id));
    } else if (request.method === "POST" && !id) {
      const { name } = startSchema.parse(JSON.parse((await readBody(request, 1024)).toString()));
      sendJson(response, 202, await logins.start(org.id, user.id, name));
    } else if (request.method === "POST" && id && action === "complete") {
      sendJson(response, 200, await logins.complete(org.id, user.id, id, options.records));
    } else if (request.method === "POST" && id && action === "cancel") {
      await logins.cancel(org.id, user.id, id);
      sendJson(response, 200, { cancelled: true });
    } else sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(response, error instanceof RecordStoreError ? error.status : 400, {
      error: error instanceof RecordStoreError ? error.message : "Invalid sign-in request",
    });
  }
  request.resume();
  return true;
}
