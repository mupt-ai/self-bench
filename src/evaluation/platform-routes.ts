import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../api/http.js";
import type { User } from "../auth/users.js";
import { tenantFor } from "../site/tenant.js";
import { readAccount } from "./account.js";
import { catalog, catalogVersion, hostedSandboxes } from "./catalog.js";
import { withReferencePricing } from "./catalog-pricing.js";
import {
  comparisonSchema,
  comparisonStatus,
  createComparison,
  dispatchComparison,
} from "./comparisons.js";
import { RecordStoreError } from "./encrypted-records.js";
import { orgCredentialRoutes } from "./org-credential-routes.js";
import { orgRecords } from "./org-records.js";
import type { EvaluationRoutesOptions } from "./routes.js";

const pattern =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/evaluations\/(catalog|credentials|comparisons)(?:\/([a-f0-9-]{36}|migrate))?(?:\/(resume|delete))?$/;
export async function platformRoutes(
  options: EvaluationRoutesOptions,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
): Promise<boolean> {
  const match = pattern.exec(url.pathname);
  if (!match) return false;
  response.setHeader("cache-control", "no-store");
  const tenant = await tenantFor(options.users, user, match[1] ?? "");
  const repo = tenant ? await options.repos.find(tenant.id, `${match[2]}/${match[3]}`) : undefined;
  if (!tenant || !repo) {
    sendJson(response, 404, { error: "Repository not found" });
    return true;
  }
  const env = options.env ?? process.env;
  const section = match[4],
    id = match[5],
    action = match[6];
  if (section === "credentials") {
    if (id === "migrate") {
      sendJson(response, 410, {
        error:
          "Add organization credentials in organization settings. Personal setups remain private.",
      });
      return true;
    }
    const target = new URL(url);
    target.pathname = `/api/orgs/${tenant.login}/credentials${id ? `/${id}/${action ?? ""}` : ""}`;
    return orgCredentialRoutes(options, request, target, response, user);
  }
  if (request.method === "GET" && section === "catalog" && !id) {
    sendJson(response, 200, {
      version: catalogVersion,
      models: catalog.map(withReferencePricing),
      sandboxes: hostedSandboxes,
      customHosts: (env.SELFBENCH_CUSTOM_MODEL_HOSTS ?? "").split(",").filter(Boolean),
    });
    return true;
  }
  if (
    request.method !== "GET" &&
    (request.method !== "POST" ||
      request.headers.origin !== new URL(options.publicUrl).origin ||
      !request.headers["content-type"]?.startsWith("application/json"))
  ) {
    sendJson(response, 403, { error: "Same-origin JSON request required" });
    return true;
  }
  try {
    if (!options.records) throw new RecordStoreError(503);
    const records = orgRecords(options.records, tenant.id);
    if (section === "comparisons") {
      if (request.method === "POST" && !id) {
        const draft = comparisonSchema.parse(
          JSON.parse((await readBody(request, 30_000)).toString()),
        );
        const record = await createComparison(
          records,
          options.tasks,
          {
            repoId: repo.id,
            ownerId: tenant.id,
            credentialOrgId: tenant.id,
            tenant: tenant.login,
            login: user.login,
          },
          draft,
        );
        let submissionError: string | undefined;
        try {
          await dispatchComparison(options.artifacts, record, options.start);
        } catch {
          submissionError =
            "Comparison saved. Some submissions were not confirmed; resume safely using this comparison.";
        }
        sendJson(response, 202, {
          ...(await comparisonStatus(options.artifacts, record)),
          submissionError,
        });
      } else {
        const comparisons = [
          ...(await readAccount(records, tenant.id)).comparisons,
          ...(await readAccount(options.records, user.githubId)).comparisons,
        ].filter((record) => record.repoId === repo.id);
        const record = comparisons.find((entry) => entry.id === id);
        if (!id && request.method === "GET")
          sendJson(response, 200, {
            comparisons: await Promise.all(
              comparisons.map((entry) => comparisonStatus(options.artifacts, entry)),
            ),
          });
        else if (!record) sendJson(response, 404, { error: "Comparison not found" });
        else if (request.method === "GET" && !action)
          sendJson(response, 200, await comparisonStatus(options.artifacts, record));
        else if (request.method === "POST" && action === "resume") {
          let submissionError: string | undefined;
          try {
            await dispatchComparison(options.artifacts, record, options.start);
          } catch {
            submissionError = "Submission not confirmed. Resume uses the same run IDs.";
          }
          sendJson(response, 202, {
            ...(await comparisonStatus(options.artifacts, record)),
            submissionError,
          });
        } else sendJson(response, 405, { error: "Method not allowed" });
      }
    } else sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    if (error instanceof RecordStoreError)
      sendJson(response, error.status, { error: error.message });
    else
      sendJson(response, 400, {
        error:
          error instanceof Error && error.name !== "ZodError"
            ? error.message
            : "Invalid selection or credential fields",
      });
  }
  request.resume();
  return true;
}
