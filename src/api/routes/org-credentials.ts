import type { IncomingMessage, ServerResponse } from "node:http";
import { RecordStoreError } from "../../db/encrypted-records.js";
import type { User } from "../../db/users.js";
import {
  credentialSchema,
  deleteCredential,
  listCredentials,
  saveCredential,
} from "../../evaluation/credentials.js";
import { orgRecords } from "../../evaluation/org-records.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

const pattern = /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/credentials(?:\/([a-f0-9-]{36})\/delete)?$/;

export async function orgCredentialRoutes(
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
  const mutation = request.method !== "GET";
  if (
    mutation &&
    (request.method !== "POST" ||
      org.role !== "admin" ||
      !trustedMutation(request, options.publicUrl, user))
  ) {
    sendJson(response, 403, { error: "Organization admin and same-origin JSON request required" });
    return true;
  }
  try {
    if (!options.records) throw new RecordStoreError(503);
    const records = orgRecords(options.records, org.id);
    if (!mutation && !match[2]) {
      sendJson(response, 200, {
        credentials: await listCredentials(records, org.id),
        canManage: org.role === "admin",
      });
    } else if (mutation && match[2]) {
      await deleteCredential(records, options.artifacts, org.id, match[2]);
      sendJson(response, 200, { deleted: true });
    } else if (mutation) {
      const draft = credentialSchema.parse(
        JSON.parse((await readBody(request, 40_000)).toString()),
      );
      sendJson(
        response,
        201,
        await saveCredential(records, org.id, draft, options.env ?? process.env),
      );
    } else sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(response, error instanceof RecordStoreError ? error.status : 400, {
      error:
        error instanceof Error && error.name !== "ZodError"
          ? error.message
          : "Invalid credential fields",
    });
  }
  request.resume();
  return true;
}
