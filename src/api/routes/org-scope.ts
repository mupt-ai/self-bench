import type { IncomingMessage, ServerResponse } from "node:http";
import type { Org, User } from "../../db/users.js";
import { unfinished } from "../../evaluation/comparisons.js";
import type { EvaluationScope } from "../../evaluation/scope.js";
import { tenantFor } from "../auth/tenant.js";
import { sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

/** A response: its status and body. */
export type Reply = readonly [status: number, body: unknown];

/**
 * What an org's collection of evaluation scopes (benchmarks, repository groups) checks first:
 * the org is the person's, and a change comes from the app itself. Answers and returns undefined
 * when not; otherwise the org, and `send`, which answers and says the response was sent.
 */
export async function openOrgScope(
  options: EvaluationRoutesOptions,
  request: IncomingMessage,
  response: ServerResponse,
  user: User,
  login: string,
  available: boolean,
): Promise<{ tenant: Org; send: (reply: Reply) => true } | { sent: true }> {
  response.setHeader("cache-control", "no-store");
  const send = ([status, body]: Reply): true => {
    sendJson(response, status, body);
    request.resume();
    return true;
  };
  const tenant = await tenantFor(options.users, user, login);
  if (!tenant || !available) return { sent: send([404, { error: "Organization not found" }]) };
  if (request.method !== "GET" && !trustedMutation(request, options.publicUrl, user))
    return { sent: send([403, { error: "Same-origin JSON request required" }]) };
  return { tenant, send };
}

/** Why a scope cannot be removed yet: its runs are followed and cancelled only through it. */
export async function unfinishedRuns(
  options: EvaluationRoutesOptions,
  scope: EvaluationScope,
  noun: string,
): Promise<Reply | undefined> {
  const records = options.vault ? await options.vault.comparisons.listForScope(scope) : [];
  const active = await Promise.all(records.map((record) => unfinished(options.artifacts, record)));
  return active.includes(true)
    ? [409, { error: `Cancel this ${noun}'s unfinished runs before removing it` }]
    : undefined;
}
