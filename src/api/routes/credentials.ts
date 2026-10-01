import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { credentialSchema } from "../../db/credentials.js";
import { RecordStoreError } from "../../db/encrypted-records.js";
import type { User } from "../../db/users.js";
import { assertCredentialUnused } from "../../evaluation/comparisons.js";
import { claudeLogins } from "../../harnesses/claude-code/login.js";
import { codexLogins } from "../../harnesses/codex/login.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

const pattern =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/credentials(?:\/(codex-login|claude-login)(?:\/([a-f0-9-]{36})(?:\/(cancel|complete))?)?|\/([a-f0-9-]{36})\/delete)?$/;
const loginStartSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const claudeCompleteSchema = z.object({ code: z.string().trim().min(1).max(4096) }).strict();

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
  const login = match[2];
  const mutation = request.method !== "GET";
  if (
    ((mutation || login) && org.role !== "admin") ||
    (mutation && (request.method !== "POST" || !trustedMutation(request, options.publicUrl, user)))
  ) {
    sendJson(response, 403, { error: "Organization admin and same-origin JSON request required" });
    return true;
  }
  const [loginId, loginAction, deleteId] = [match[3], match[4], match[5]];
  try {
    if (!options.vault) throw new RecordStoreError(503);
    const vault = options.vault;
    const { credentials, comparisons } = vault;
    if (login) {
      const codex = options.codexLogins ?? codexLogins;
      const claude = options.claudeLogins ?? claudeLogins;
      const logins = login === "codex-login" ? codex : claude;
      const body = async (limit: number) => JSON.parse((await readBody(request, limit)).toString());
      // Codex polls OpenAI for the approval; Claude is completed with the code Anthropic shows.
      if (login === "codex-login" && !mutation && loginId && !loginAction)
        sendJson(response, 200, await codex.status(vault, org.id, user.id, loginId));
      else if (login === "claude-login" && mutation && loginId && loginAction === "complete") {
        const { code } = claudeCompleteSchema.parse(await body(8192));
        sendJson(response, 200, await claude.complete(vault, org.id, user.id, loginId, code));
      } else if (mutation && !loginId) {
        const { name } = loginStartSchema.parse(await body(1024));
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
      error: login
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
