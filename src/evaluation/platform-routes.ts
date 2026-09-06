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
import {
  credentialSchema,
  deleteCredential,
  listCredentials,
  saveCredential,
} from "./credentials.js";
import { type EncryptedRecordStore, RecordStoreError } from "./encrypted-records.js";
import { listSetups, readSetup } from "./profiles.js";
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
    const records = options.records;
    if (!records) throw new RecordStoreError(503);
    if (section === "credentials") {
      if (request.method === "GET" && !id)
        sendJson(response, 200, { credentials: await listCredentials(records, user.githubId) });
      else if (request.method === "POST" && id === "migrate")
        sendJson(response, 200, {
          migrated: await migrate(records, options, repo.id, user.githubId, env),
        });
      else if (request.method === "POST" && id && action === "delete") {
        await deleteCredential(records, options.artifacts, user.githubId, id);
        sendJson(response, 200, { deleted: true });
      } else if (request.method === "POST" && !id) {
        const draft = credentialSchema.parse(
          JSON.parse((await readBody(request, 40_000)).toString()),
        );
        sendJson(response, 201, await saveCredential(records, user.githubId, draft, env));
      } else sendJson(response, 405, { error: "Method not allowed" });
    } else if (section === "comparisons") {
      if (request.method === "POST" && !id) {
        const draft = comparisonSchema.parse(
          JSON.parse((await readBody(request, 30_000)).toString()),
        );
        const record = await createComparison(
          records,
          options.tasks,
          { repoId: repo.id, ownerId: user.githubId, tenant: tenant.login, login: user.login },
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
        const comparisons = (await readAccount(records, user.githubId)).comparisons.filter(
          (record) => record.repoId === repo.id,
        );
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
async function migrate(
  records: EncryptedRecordStore,
  options: EvaluationRoutesOptions,
  repoId: number,
  ownerId: number,
  env: NodeJS.ProcessEnv,
) {
  const ids: string[] = [];
  for (const profile of await listSetups(options.artifacts, repoId, ownerId, env)) {
    const setup = await readSetup(options.artifacts, repoId, ownerId, profile.id, env);
    if (
      !setup ||
      !["openai", "anthropic", "openrouter"].includes(setup.provider) ||
      setup.sandbox === "docker"
    )
      continue;
    const model = await saveCredential(
      records,
      ownerId,
      credentialSchema.parse({
        name: `${setup.provider} · imported`,
        kind: setup.provider,
        value: setup.modelApiKey,
      }),
      env,
      `${repoId}/${profile.id}/model`,
    );
    const sandbox = await saveCredential(
      records,
      ownerId,
      credentialSchema.parse({
        name: `${setup.sandbox} · imported`,
        kind: setup.sandbox,
        value: setup.sandboxApiKey ?? setup.modalTokenSecret,
        tokenId: setup.modalTokenId,
      }),
      env,
      `${repoId}/${profile.id}/sandbox`,
    );
    ids.push(model.id, sandbox.id);
  }
  return ids;
}
