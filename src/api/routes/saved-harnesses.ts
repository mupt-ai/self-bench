import type { IncomingMessage, ServerResponse } from "node:http";
import { savedHarnessSchema } from "../../contracts/saved-harnesses.js";
import { HarnessNameTaken } from "../../db/saved-harnesses.js";
import type { User } from "../../db/users.js";
import { evaluationCatalog } from "../../evaluation/catalog.js";
import { modelHarnesses } from "../../evaluation/models.js";
import { providerServesSubagent, subagentSupport } from "../../evaluation/subagents.js";
import { managedOffer } from "../../generation/billing/managed.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

// `conditions` is what they were called before they were harnesses, kept for older clients.
const route = /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/(harnesses|conditions)(?:\/(\d{1,15}|models))?$/;

/**
 * The catalog models a saved harness's subagents can run on: those some credential serves by name to
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
 * A workspace's saved harnesses (saved-harness-schema.ts): named agent changes any member saves,
 * and any comparison in the workspace picks by id (`harnesses: [id]`).
 *
 * - `GET harnesses`: every saved harness, by name.
 * - `POST harnesses {name, agent?, skills?, instructions?, harnessOptions?, subagent?}`: saves one.
 * - `GET harnesses/{id}`: one.
 * - `PUT harnesses/{id} {…}`: replaces one. Runs that already used it keep what they ran.
 * - `DELETE harnesses/{id}`: removes one.
 * - `GET harnesses/models`: the models a harness's subagents can run on, and whether the
 *   managed key serves them (`managed`).
 *
 * Under the older `conditions` path, replies name them `conditions` and `condition`.
 */
export async function savedHarnessRoutes(
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
  const [one, many] =
    match[2] === "conditions" ? ["condition", "conditions"] : ["harness", "harnesses"];
  const listing = match[3] === "models";
  const id = match[3] && !listing ? Number(match[3]) : undefined;
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
    // Whether SelfBench's own key serves models here, so the editor can offer it to subagents.
    sendJson(response, 200, { models: subagentModels(), managed: managedOffer().models });
    return true;
  }
  const store = options.vault?.harnesses;
  if (!store) {
    sendJson(response, 503, { error: "Saved harnesses are unavailable" });
    return true;
  }
  const missing = () => sendJson(response, 404, { error: "harness not found" });
  if (method === "GET") {
    if (id === undefined) sendJson(response, 200, { [many]: await store.list(org.id) });
    else {
      const harness = await store.find(org.id, id);
      if (harness) sendJson(response, 200, { [one]: harness });
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
    sendJson(response, 400, { error: "Send the harness as JSON." });
    return true;
  }
  const parsed = savedHarnessSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    sendJson(response, 400, {
      error: issue ? `${issue.path.join(".") || "harness"}: ${issue.message}` : "Invalid harness",
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
  const credentialId = subagent?.credentialId;
  if (
    credentialId &&
    credentialId !== "managed-model" &&
    !(await options.vault?.credentials.find(org.id, credentialId))
  ) {
    sendJson(response, 400, {
      error: "subagent.credentialId: no such credential in this workspace",
    });
    return true;
  }
  try {
    const harness =
      id === undefined
        ? await store.create(org.id, parsed.data, user.id)
        : await store.update(org.id, id, parsed.data);
    if (harness) sendJson(response, id === undefined ? 201 : 200, { [one]: harness });
    else missing();
  } catch (error) {
    if (!(error instanceof HarnessNameTaken)) throw error;
    sendJson(response, 409, { error: error.message });
  }
  return true;
}
