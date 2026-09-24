import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { credentialSchema } from "../../db/credentials.js";
import { RecordStoreError } from "../../db/encrypted-records.js";
import type { User } from "../../db/users.js";
import { assertCredentialUnused } from "../../evaluation/comparisons.js";
import { codexLogins } from "../../harnesses/codex/login.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

const pattern =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/credentials(?:\/codex-login(?:\/([a-f0-9-]{36})(?:\/(cancel))?)?|\/([a-f0-9-]{36})\/delete)?$/;
const codexStartSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();

/** Organization credentials: anyone in the org lists them; only admins add or delete them. */
export async function credentialRoutes(
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
  const codex = url.pathname.includes("/credentials/codex-login");
  const mutation = request.method !== "GET";
  if (
    ((mutation || codex) && org.role !== "admin") ||
    (mutation && (request.method !== "POST" || !trustedMutation(request, options.publicUrl, user)))
  ) {
    sendJson(response, 403, { error: "Organization admin and same-origin JSON request required" });
    return true;
  }
  const [loginId, loginAction, deleteId] = [match[2], match[3], match[4]];
  try {
    if (!options.vault) throw new RecordStoreError(503);
    const vault = options.vault;
    const { credentials, comparisons } = vault;
    if (codex) {
      const logins = options.codexLogins ?? codexLogins;
      if (!mutation && loginId && !loginAction)
        sendJson(response, 200, await logins.status(vault, org.id, user.id, loginId));
      else if (mutation && !loginId) {
        const { name } = codexStartSchema.parse(
          JSON.parse((await readBody(request, 1024)).toString()),
        );
        sendJson(response, 202, await logins.start(vault, org.id, user.id, name));
      } else if (mutation && loginId && loginAction === "cancel") {
        await logins.cancel(vault, org.id, user.id, loginId);
        sendJson(response, 200, { cancelled: true });
      } else sendJson(response, 405, { error: "Method not allowed" });
    } else if (!mutation && !deleteId) {
      sendJson(response, 200, {
        credentials: await credentials.list(org.id),
        canManage: org.role === "admin",
      });
    } else if (mutation && deleteId) {
      if (!(await credentials.find(org.id, deleteId))) throw new Error("Credential not found");
      await assertCredentialUnused(comparisons, options.artifacts, org.id, deleteId);
      await credentials.remove(org.id, deleteId);
      sendJson(response, 200, { deleted: true });
    } else if (mutation) {
      const draft = credentialSchema.parse(
        JSON.parse((await readBody(request, 40_000)).toString()),
      );
      sendJson(response, 201, await credentials.create(org.id, draft, options.env ?? process.env));
    } else sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(response, error instanceof RecordStoreError ? error.status : 400, {
      error: codex
        ? error instanceof RecordStoreError
          ? error.message
          : "Invalid sign-in request"
        : error instanceof Error && error.name !== "ZodError"
          ? error.message
          : "Invalid credential fields",
    });
  }
  request.resume();
  return true;
}
