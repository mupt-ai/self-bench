import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { isSandboxKind } from "../../db/credential-kinds.js";
import { credentialSchema, maxSandboxesSchema, savedModelsSchema } from "../../db/credentials.js";
import { RecordStoreError } from "../../db/encrypted-records.js";
import type { User } from "../../db/users.js";
import { assertCredentialUnused } from "../../evaluation/comparisons.js";
import { claudeLogins } from "../../harnesses/claude-code/login.js";
import { codexLogins } from "../../harnesses/codex/login.js";
import { museLogins } from "../../harnesses/muse-code/login.js";
import { inferResourceLimits } from "../../sandbox/resource-inference.js";
import { resourceLimitsSchema, savedResourceLimits } from "../../sandbox/resources.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

const pattern =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/credentials(?:\/(codex-login|claude-login|muse-login)(?:\/([a-f0-9-]{36})(?:\/(cancel|complete))?)?|\/([a-f0-9-]{36})\/(delete|limit|update|infer-limits))?$/;
const loginStartSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const claudeCompleteSchema = z.object({ code: z.string().trim().min(1).max(4096) }).strict();
// Each field left out stays as it is; a null limit clears it. (`limit` is the old name of `update`.)
const updateSchema = z
  .object({
    name: credentialSchema.shape.name.optional(),
    maxSandboxes: maxSandboxesSchema.nullable().optional(),
    maxBuilds: maxSandboxesSchema.nullable().optional(),
    models: savedModelsSchema.optional(),
    resourceLimits: resourceLimitsSchema.nullable().optional(),
  })
  .strict();

/**
 * Organization credentials: anyone in the org lists them; only admins add, delete, rename, or set
 * a credential's limits.
 */
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
  const [loginId, loginAction, credentialId, action] = [match[3], match[4], match[5], match[6]];
  const infer = options.inferResourceLimits ?? inferResourceLimits;
  try {
    if (!options.vault) throw new RecordStoreError(503);
    const vault = options.vault;
    const { credentials, comparisons } = vault;
    if (login) {
      const codex = options.codexLogins ?? codexLogins;
      const claude = options.claudeLogins ?? claudeLogins;
      const muse = options.museLogins ?? museLogins;
      const logins = login === "codex-login" ? codex : login === "muse-login" ? muse : claude;
      const body = async (limit: number) => JSON.parse((await readBody(request, limit)).toString());
      // Codex and Muse poll their device sign-ins for the approval; Claude is completed with the
      // code Anthropic shows.
      if (login !== "claude-login" && !mutation && loginId && !loginAction)
        sendJson(
          response,
          200,
          await (login === "muse-login" ? muse : codex).status(vault, org.id, user.id, loginId),
        );
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
    } else if (!mutation && !credentialId) {
      sendJson(response, 200, {
        credentials: await credentials.list(org.id),
        canManage: org.role === "admin",
      });
    } else if (mutation && credentialId && (action === "update" || action === "limit")) {
      const { name, maxSandboxes, maxBuilds, models, resourceLimits } = updateSchema.parse(
        JSON.parse((await readBody(request, 8192)).toString()),
      );
      if (name !== undefined) await credentials.rename(org.id, credentialId, name);
      if (maxSandboxes !== undefined)
        await credentials.limit(org.id, credentialId, maxSandboxes ?? undefined);
      if (maxBuilds !== undefined)
        await credentials.limit(org.id, credentialId, maxBuilds ?? undefined, "maxBuilds");
      if (models !== undefined) await credentials.saveModels(org.id, credentialId, models);
      if (resourceLimits !== undefined)
        await credentials.setResourceLimits(org.id, credentialId, resourceLimits ?? undefined);
      sendJson(response, 200, await credentials.find(org.id, credentialId));
    } else if (mutation && credentialId && action === "infer-limits") {
      // Reads the account's limits with its saved key and returns them; saving is the editor's.
      const credential = await credentials.find(org.id, credentialId);
      const secret = credential && (await credentials.secret(org.id, credentialId));
      if (!credential || !secret) throw new Error("Credential not found");
      if (!isSandboxKind(credential.kind)) throw new Error("Only sandbox providers have limits");
      sendJson(response, 200, await infer(credential.kind, secret));
    } else if (mutation && credentialId) {
      if (!(await credentials.find(org.id, credentialId))) throw new Error("Credential not found");
      await assertCredentialUnused(comparisons, options.artifacts, org.id, credentialId);
      await credentials.remove(org.id, credentialId);
      sendJson(response, 200, { deleted: true });
    } else if (mutation) {
      const draft = credentialSchema.parse(
        JSON.parse((await readBody(request, 40_000)).toString()),
      );
      // A new sandbox account starts with its plan's limits, where its provider shares them.
      if (isSandboxKind(draft.kind) && !savedResourceLimits(draft.resourceLimits)) {
        const inferred = await infer(draft.kind, draft).catch(() => undefined);
        if (inferred?.limits) draft.resourceLimits = inferred.limits;
      }
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
