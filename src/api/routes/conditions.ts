import type { IncomingMessage, ServerResponse } from "node:http";
import { savedConditionSchema } from "../../contracts/conditions.js";
import { ConditionNameTaken } from "../../db/saved-conditions.js";
import type { User } from "../../db/users.js";
import { evaluationCatalog } from "../../evaluation/catalog.js";
import { modelHarnesses } from "../../evaluation/models.js";
import { providerServesSubagent, subagentSupport } from "../../evaluation/subagents.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

const route = /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/conditions(?:\/(\d{1,15}|models))?$/;

/**
 * The catalog models a condition's subagents can run on: those some credential serves by name to
 * a harness that takes a subagent model, which Dari's router and custom endpoints do not.
 */
function subagentModels(): { id: string; label: string }[] {
  return evaluationCatalog()
    .filter(
      (model) =>
        providerServesSubagent(model.provider) &&
        modelHarnesses(model).some((harness) => subagentSupport[harness].configurable),
    )
    .map(({ id, label }) => ({ id, label }));
}

/**
 * A workspace's saved conditions (condition-schema.ts): named harness changes any member saves,
 * and any comparison in the workspace picks by id (`conditions: [{ saved }]`).
 *
 * - `GET conditions`: every saved condition, by name.
 * - `POST conditions {name, skills?, instructions?, harnessOptions?, subagent?}`: saves one.
 * - `GET conditions/{id}`: one.
 * - `PUT conditions/{id} {…}`: replaces one. Runs that already used it keep what they ran.
 * - `DELETE conditions/{id}`: removes one.
 * - `GET conditions/models`: the models a condition's subagents can run on.
 */
export async function conditionRoutes(
  options: Pick<EvaluationRoutesOptions, "users" | "vault" | "publicUrl">,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
): Promise<boolean> {
  const match = route.exec(url.pathname);
  if (!match) return false;
  response.setHeader("cache-control", "no-store");
  const method = request.method ?? "GET";
  const listing = match[2] === "models";
  const id = match[2] && !listing ? Number(match[2]) : undefined;
  const allowed = listing ? ["GET"] : id === undefined ? ["GET", "POST"] : ["GET", "PUT", "DELETE"];
  if (!allowed.includes(method)) {
    sendJson(response, 405, { error: "Method not allowed" });
    return true;
  }
  if (method !== "GET" && !trustedMutation(request, options.publicUrl, user)) {
    sendJson(response, 403, { error: "Same-origin JSON request required" });
    return true;
  }
  const org = await tenantFor(options.users, user, match[1] ?? "");
  if (!org) {
    sendJson(response, 404, { error: "Organization not found" });
    return true;
  }
  if (listing) {
    sendJson(response, 200, { models: subagentModels() });
    return true;
  }
  const store = options.vault?.conditions;
  if (!store) {
    sendJson(response, 503, { error: "Saved conditions are unavailable" });
    return true;
  }
  const missing = () => sendJson(response, 404, { error: "condition not found" });
  if (method === "GET") {
    if (id === undefined) sendJson(response, 200, { conditions: await store.list(org.id) });
    else {
      const condition = await store.find(org.id, id);
      if (condition) sendJson(response, 200, { condition });
      else missing();
    }
    return true;
  }
  if (method === "DELETE" && id !== undefined) {
    if (await store.remove(org.id, id)) sendJson(response, 200, { deleted: true });
    else missing();
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse((await readBody(request, 100_000)).toString("utf8"));
  } catch {
    sendJson(response, 400, { error: "Send the condition as JSON." });
    return true;
  }
  const parsed = savedConditionSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    sendJson(response, 400, {
      error: issue
        ? `${issue.path.join(".") || "condition"}: ${issue.message}`
        : "Invalid condition",
    });
    return true;
  }
  const { subagent } = parsed.data;
  if (subagent && !subagentModels().some((model) => model.id === subagent.catalogId)) {
    sendJson(response, 400, {
      error: `subagent.catalogId: ${subagent.catalogId} is not a model subagents can run on`,
    });
    return true;
  }
  try {
    const condition =
      id === undefined
        ? await store.create(org.id, parsed.data, user.id)
        : await store.update(org.id, id, parsed.data);
    if (condition) sendJson(response, id === undefined ? 201 : 200, { condition });
    else missing();
  } catch (error) {
    if (!(error instanceof ConditionNameTaken)) throw error;
    sendJson(response, 409, { error: error.message });
  }
  return true;
}
