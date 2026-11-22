import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { isSandboxKind } from "../../db/credential-kinds.js";
import { credentialSchema, maxSandboxesSchema, savedModelsSchema } from "../../db/credentials.js";
import { RecordStoreError } from "../../db/encrypted-records.js";
import type { User } from "../../db/users.js";
import { assertCredentialUnused } from "../../evaluation/run-batches.js";
import {
  connectDari,
  DARI_LINK_CALLBACK_PATH,
  dariLinkApp,
  dariLinkGrants,
  revokeDari,
} from "../../gateway/dari-link/link.js";
import { dariLinkStatus } from "../../gateway/dari-link/status.js";
import { reportError } from "../../lib/telemetry/sentry.js";
import { inferResourceLimits } from "../../sandbox/resource-inference.js";
import { resourceLimitsSchema, savedResourceLimits } from "../../sandbox/resources.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

const pattern =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/credentials(?:\/([a-f0-9-]{36})\/(delete|limit|update|infer-limits|dari-status)|\/(dari-link))?$/;
/** What `DariLink.open` resolved with in the browser. */
const dariLinkSchema = z
  .object({ code: z.string().min(1).max(2048), codeVerifier: z.string().min(43).max(128) })
  .strict();
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
  const dariLink =
    options.dariLinkApp === undefined
      ? dariLinkApp(options.env ?? process.env)
      : options.dariLinkApp;
  const mutation = request.method !== "GET";
  if (
    (mutation && org.role !== "admin") ||
    (mutation && (request.method !== "POST" || !trustedMutation(request, options.publicUrl, user)))
  ) {
    sendJson(response, 403, { error: "Organization admin and same-origin JSON request required" });
    return true;
  }
  const [credentialId, action] = [match[2], match[3]];
  const linking = match[4] !== undefined;
  const infer = options.inferResourceLimits ?? inferResourceLimits;
  try {
    if (!options.vault) throw new RecordStoreError(503);
    const vault = options.vault;
    const { credentials, batches } = vault;
    if (linking && mutation) {
      // Connect with Dari: the browser's approved code and its PKCE verifier, redeemed here.
      if (!dariLink) throw new RecordStoreError(503, "Dari Link is not configured here.");
      const approved = dariLinkSchema.parse(JSON.parse((await readBody(request, 4096)).toString()));
      sendJson(response, 201, await connectDari(vault, org.id, dariLink, approved));
    } else if (!mutation && !credentialId && !linking) {
      const { gatewayUrl, clientId, redirectUri } = dariLink ?? {};
      sendJson(response, 200, {
        credentials: await credentials.list(org.id),
        canManage: org.role === "admin",
        // What the browser's Connect with Dari needs; null when this deployment has no Dari Link.
        dariLink:
          gatewayUrl && clientId && redirectUri ? { gatewayUrl, clientId, redirectUri } : null,
      });
    } else if (!mutation && credentialId && action === "dari-status") {
      // Each plan's state and usage now, from Dari: never stored here.
      const grants = dariLinkGrants(credentials, dariLink ?? undefined);
      sendJson(response, 200, await dariLinkStatus(grants, org.id, credentialId));
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
      const credential = await credentials.find(org.id, credentialId);
      if (!credential) throw new Error("Credential not found");
      await assertCredentialUnused(batches, options.artifacts, org.id, credentialId);
      // A Dari Link grant is ended on Dari too, so Dari no longer lists SelfBench.
      const linked =
        credential.auth === "dari-link"
          ? (await credentials.secret(org.id, credentialId))?.value
          : undefined;
      await credentials.remove(org.id, credentialId);
      if (linked)
        // The row is gone either way; a grant Dari kept is reported, and the user can end it on Dari.
        await revokeDari(dariLink, linked).catch((error) =>
          reportError(error, { tags: { route: "credentials", step: "dari-revoke" } }),
        );
      sendJson(response, 200, { deleted: true });
    } else if (mutation) {
      const draft = credentialSchema.parse(
        JSON.parse((await readBody(request, 40_000)).toString()),
      );
      if (draft.auth === "dari-link") throw new Error("Connect Dari plans with Connect with Dari");
      // A new sandbox account starts with its plan's limits, where its provider shares them.
      if (isSandboxKind(draft.kind) && !savedResourceLimits(draft.resourceLimits)) {
        const inferred = await infer(draft.kind, draft).catch(() => undefined);
        if (inferred?.limits) draft.resourceLimits = inferred.limits;
      }
      sendJson(response, 201, await credentials.create(org.id, draft, options.env ?? process.env));
    } else sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(response, error instanceof RecordStoreError ? error.status : 400, {
      error: linking
        ? error instanceof Error && error.name !== "ZodError"
          ? error.message
          : "Invalid Dari Link request"
        : error instanceof Error && error.name !== "ZodError"
          ? error.message
          : "Invalid credential fields",
    });
  }
  request.resume();
  return true;
}

/**
 * Dari Link's redirect URI. Connect with Dari's popup normally posts its result straight to the
 * SelfBench window that opened it; when the popup lost its opener (a sign-in on the way can do
 * that), Dari sends the popup here instead, and this page does what `DariLink.callback()` does:
 * hands the code to that window over a same-origin BroadcastChannel and closes itself. The window
 * that opened the popup holds the PKCE verifier, so only it can redeem the code.
 */
const CALLBACK_SCRIPT = `(() => {
  const params = new URLSearchParams(location.search);
  const state = params.get("state"), code = params.get("code"), error = params.get("error");
  history.replaceState(null, "", location.pathname);
  if (state && (code || error) && "BroadcastChannel" in window) {
    const channel = new BroadcastChannel("dari-link");
    channel.postMessage(code
      ? { type: "dari-link", state, code }
      : { type: "dari-link", state, error, error_description: params.get("error_description") || undefined });
    channel.close();
    window.close();
  }
  document.getElementById("status").textContent = "You can close this window and return to SelfBench.";
})();`;
const CALLBACK_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect with Dari</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}</style>
</head><body><h1>Connect with Dari</h1><p id="status">Returning to SelfBench…</p>
<script>${CALLBACK_SCRIPT}</script></body></html>`;
const CALLBACK_CSP = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${createHash("sha256").update(CALLBACK_SCRIPT).digest("base64")}'`;

export function dariLinkCallbackRoute(
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
): boolean {
  if (url.pathname !== DARI_LINK_CALLBACK_PATH) return false;
  request.resume();
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return true;
  }
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": CALLBACK_CSP,
    "referrer-policy": "no-referrer",
  });
  response.end(CALLBACK_PAGE);
  return true;
}
