import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { customerPackage } from "../../customer-exports/package.js";
import {
  type CustomerExport,
  type CustomerExportRequest,
  EXPORT_DAYS,
  exportPrefix,
} from "../../customer-exports/types.js";
import { GrantRefusal, type RegistryGrantStore } from "../../db/registry-grants.js";
import type { User } from "../../db/users.js";
import { sameScope } from "../../evaluation/scope.js";
import { listEvaluations } from "../../evaluation/store.js";
import type { EvaluationInput } from "../../evaluation/types.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

/** What customer exports need: grants on the task image repository, which `/v2/` serves. */
export interface CustomerExportRegistry {
  readonly grants: Pick<RegistryGrantStore, "createForImages" | "find" | "revoke">;
  /** `<region>-docker.pkg.dev/<project>/<repository>`, the task image repository. */
  readonly repository: string;
}

/** The export's own content was refused: the caller's to fix, not a server fault. */
class PackageError extends Error {}

const schema = z.strictObject({
  id: z.uuid(),
  customer: z.string().trim().min(1).max(100),
});
export async function customerExportRoute(
  options: EvaluationRoutesOptions,
  request: IncomingMessage,
  response: ServerResponse,
  owner: { repoId: number; orgId: number; user: User },
  id?: string,
  action?: string,
) {
  const { artifacts } = options;
  const exports = options.customerExports;
  const prefix = exportPrefix(owner.repoId);
  const read = async <T>(key: string): Promise<T | undefined> => {
    const bytes = await artifacts.getByKey(key);
    return bytes ? (JSON.parse(Buffer.from(bytes).toString()) as T) : undefined;
  };
  // Exports made before grants (Google registry copies) have no grantId and are not listed.
  const saved = async (key: string) => {
    const found = await read<CustomerExportRequest>(key);
    return found?.grantId ? found : undefined;
  };
  const describe = async (entry: CustomerExportRequest): Promise<CustomerExport | undefined> => {
    const grant = await exports?.grants.find(entry.grantId);
    if (!grant) return undefined;
    return {
      id: entry.id,
      customer: entry.customer,
      evaluationId: entry.evaluationId,
      evaluationCreatedAt: entry.evaluationCreatedAt,
      createdAt: entry.createdAt,
      expiresAt: grant.expiresAt.toISOString(),
      status: grant.revokedAt ? "revoked" : grant.expiresAt <= new Date() ? "expired" : "ready",
    };
  };
  if (request.method === "GET") {
    if (id) {
      const entry = await saved(`${exportPrefix(owner.repoId, id)}request.json`);
      const state = entry && (await describe(entry));
      if (!state) return sendJson(response, 404, { error: "Export not found" });
      if (action !== "download") return sendJson(response, 200, state);
      const bytes = await artifacts.getByKey(`${exportPrefix(owner.repoId, id)}harbor.zip`);
      if (!bytes) return sendJson(response, 404, { error: "Export file not found" });
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="harbor-eval.zip"',
        "x-content-type-options": "nosniff",
      });
      response.end(bytes);
      return;
    }
    const entries = (await artifacts.list(prefix.slice(0, -1))).filter(
      (entry) => entry.key.startsWith(prefix) && entry.key.endsWith("/request.json"),
    );
    const found = await Promise.all(
      entries.map(async (entry) => {
        const record = await saved(entry.key);
        return record ? describe(record) : undefined;
      }),
    );
    return sendJson(response, 200, {
      enabled: !!exports,
      exports: found
        .filter((entry): entry is CustomerExport => !!entry)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    });
  }
  if (request.method !== "POST" || (id && action !== "revoke") || (!id && action))
    return sendJson(response, 405, { error: "Method not allowed" });
  if (!trustedMutation(request, options.publicUrl, owner.user))
    return sendJson(response, 403, { error: "Same-origin JSON request required" });
  if (!exports || !options.vault)
    return sendJson(response, 503, { error: "Customer exports are not configured" });
  if (id) {
    const entry = await saved(`${exportPrefix(owner.repoId, id)}request.json`);
    if (!entry) return sendJson(response, 404, { error: "Export not found" });
    await exports.grants.revoke(entry.grantId);
    return sendJson(response, 200, await describe(entry));
  }
  let body: unknown;
  try {
    body = JSON.parse((await readBody(request, 4096)).toString());
  } catch {
    return sendJson(response, 400, { error: "Invalid JSON" });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return sendJson(response, 400, { error: "Provide a customer name" });
  const input = parsed.data;
  const key = `${exportPrefix(owner.repoId, input.id)}request.json`;
  const existing = await saved(key);
  if (existing) {
    if (existing.customer !== input.customer)
      return sendJson(response, 409, { error: "This export ID belongs to a different request" });
    return sendJson(response, 200, await describe(existing));
  }
  // The newest completed evaluation whose frozen tasks are image-backed and within the export limit.
  const vault = options.vault;
  const scope = { repoId: owner.repoId };
  let picked: { id: string; createdAt: string; tasks: EvaluationInput["tasks"] } | undefined;
  for (const run of await listEvaluations(artifacts, scope)) {
    if (run.status !== "completed") continue;
    const comparison = run.comparisonId
      ? await vault.comparisons.find(run.comparisonId)
      : undefined;
    const frozen =
      comparison?.orgId === owner.orgId && sameScope(comparison.scope, scope)
        ? comparison.inputs.find((entry) => entry.id === run.id)
        : undefined;
    if (
      frozen?.tasks.length &&
      frozen.tasks.length <= 500 &&
      frozen.tasks.every(
        (task) =>
          task.images?.agent.startsWith(`${exports.repository}/`) &&
          task.images.verifier.startsWith(`${exports.repository}/`) &&
          task.bundleKey.endsWith("/execution-task.tar.gz"),
      )
    ) {
      picked = { id: run.id, createdAt: run.createdAt, tasks: frozen.tasks };
      break;
    }
  }
  if (!picked)
    return sendJson(response, 400, {
      error:
        "No completed evaluation has image-backed tasks of 500 or fewer to export. Run an evaluation of the current tasks first.",
    });
  const expiresAt = new Date(Date.now() + EXPORT_DAYS * 24 * 60 * 60 * 1000);
  // The grant shares the export's id, so a retried or concurrent request reuses it.
  let issued: Awaited<ReturnType<typeof exports.grants.createForImages>>;
  try {
    issued = await exports.grants.createForImages({
      id: input.id,
      label: `${input.customer} (export ${input.id})`,
      images: picked.tasks.flatMap((task) =>
        task.images ? [task.images.agent, task.images.verifier] : [],
      ),
      expiresAt,
    });
  } catch (error) {
    if (error instanceof GrantRefusal)
      return sendJson(response, 409, { error: "This export ID belongs to a different request" });
    throw error;
  }
  if (!issued.issued) {
    // Another request with this id issued the grant and owns writing the export.
    const finished = await saved(key);
    if (finished) return sendJson(response, 200, await describe(finished));
    return sendJson(response, 409, { error: "This export is still being created" });
  }
  const { grant, password } = issued;
  const entry: CustomerExportRequest = {
    id: input.id,
    repoId: owner.repoId,
    customer: input.customer,
    evaluationId: picked.id,
    evaluationCreatedAt: picked.createdAt,
    grantId: grant.id,
    createdAt: new Date().toISOString(),
    createdBy: owner.user.login,
    tasks: picked.tasks,
  };
  const root = exportPrefix(owner.repoId, input.id);
  try {
    let zip: Buffer;
    try {
      zip = await customerPackage(artifacts, entry, {
        host: new URL(options.publicUrl).host,
        repository: exports.repository,
        password,
        expiresAt: grant.expiresAt,
      });
    } catch (error) {
      throw new PackageError(
        error instanceof Error ? error.message : "Could not package the export",
      );
    }
    await artifacts.put(`${root}harbor.zip`, zip, "application/zip");
    // Written last: an export is listed only once its ZIP exists.
    await artifacts.put(
      `${root}request.json`,
      Buffer.from(JSON.stringify(entry)),
      "application/json",
    );
  } catch (error) {
    // Nothing was handed out, so the grant this request issued must not outlive the failed export.
    await exports.grants.revoke(grant.id);
    if (error instanceof PackageError) return sendJson(response, 400, { error: error.message });
    throw error;
  }
  sendJson(response, 201, await describe(entry));
}
