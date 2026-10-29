import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  type CustomerExport,
  type CustomerExportRequest,
  exportPrefix,
} from "../../customer-exports/types.js";
import type { User } from "../../db/users.js";
import { sameScope } from "../../evaluation/scope.js";
import { getEvaluation } from "../../evaluation/store.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

const schema = z.strictObject({
  id: z.uuid(),
  evaluationId: z.uuid(),
  customer: z.string().trim().min(1).max(100),
  email: z.email().max(254),
});
export async function customerExportRoute(
  options: EvaluationRoutesOptions,
  request: IncomingMessage,
  response: ServerResponse,
  owner: { repoId: number; orgId: number; user: User },
  id?: string,
  download?: boolean,
) {
  const { artifacts } = options;
  const prefix = exportPrefix(owner.repoId);
  const read = async <T>(key: string): Promise<T | undefined> => {
    const bytes = await artifacts.getByKey(key);
    return bytes ? (JSON.parse(Buffer.from(bytes).toString()) as T) : undefined;
  };
  const describe = async (saved: CustomerExportRequest): Promise<CustomerExport> => {
    const root = exportPrefix(owner.repoId, saved.id);
    const ready = await read<{ repository: string }>(`${root}ready.json`);
    const failed = ready ? undefined : await read<{ error: string }>(`${root}failed.json`);
    return {
      id: saved.id,
      customer: saved.customer,
      email: saved.email,
      evaluationId: saved.evaluationId,
      createdAt: saved.createdAt,
      status: ready ? "ready" : failed ? "failed" : "preparing",
      ...ready,
      ...failed,
    };
  };
  if (request.method === "GET") {
    if (id) {
      const saved = await read<CustomerExportRequest>(
        `${exportPrefix(owner.repoId, id)}request.json`,
      );
      if (!saved) return sendJson(response, 404, { error: "Export not found" });
      const state = await describe(saved);
      if (!download) return sendJson(response, 200, state);
      if (state.status !== "ready")
        return sendJson(response, 409, { error: "Export is not ready" });
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
    const exports = await Promise.all(
      entries.map(async (entry) => {
        const saved = await read<CustomerExportRequest>(entry.key);
        return saved ? describe(saved) : undefined;
      }),
    );
    return sendJson(response, 200, {
      enabled: !!options.exportCustomer,
      exports: exports
        .filter(Boolean)
        .sort((a, b) => (b?.createdAt ?? "").localeCompare(a?.createdAt ?? "")),
    });
  }
  if (request.method !== "POST" || id)
    return sendJson(response, 405, { error: "Method not allowed" });
  if (!trustedMutation(request, options.publicUrl, owner.user))
    return sendJson(response, 403, { error: "Same-origin JSON request required" });
  if (!options.exportCustomer || !options.vault)
    return sendJson(response, 503, { error: "Customer exports are not configured" });
  let body: unknown;
  try {
    body = JSON.parse((await readBody(request, 4096)).toString());
  } catch {
    return sendJson(response, 400, { error: "Invalid JSON" });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return sendJson(response, 400, {
      error: "Provide a customer name, Google account email, and evaluation",
    });
  const input = parsed.data;
  const scope = { repoId: owner.repoId };
  const run = await getEvaluation(artifacts, scope, input.evaluationId);
  if (!run || run.deletedAt || run.status !== "completed")
    return sendJson(response, 400, { error: "Choose a completed evaluation" });
  const comparison = run.comparisonId
    ? await options.vault.comparisons.find(run.comparisonId)
    : undefined;
  const frozen =
    comparison?.orgId === owner.orgId && sameScope(comparison.scope, scope)
      ? comparison.inputs.find((entry) => entry.id === run.id)
      : undefined;
  if (frozen && frozen.tasks.length > 500)
    return sendJson(response, 400, { error: "Export at most 500 tasks at a time" });
  if (
    !frozen?.tasks.length ||
    frozen.tasks.some((task) => !task.images || !task.bundleKey.endsWith("/execution-task.tar.gz"))
  )
    return sendJson(response, 400, {
      error:
        "This evaluation has no frozen image-backed execution bundles. Run an evaluation of the current image-backed tasks first.",
    });
  const key = `${exportPrefix(owner.repoId, input.id)}request.json`;
  let saved = await read<CustomerExportRequest>(key);
  if (
    saved &&
    (saved.email !== input.email ||
      saved.customer !== input.customer ||
      saved.evaluationId !== input.evaluationId)
  )
    return sendJson(response, 409, { error: "This export ID belongs to a different request" });
  if (!saved) {
    saved = {
      ...input,
      repoId: owner.repoId,
      tasks: frozen.tasks,
      createdAt: new Date().toISOString(),
      createdBy: owner.user.login,
    };
    await artifacts.put(key, Buffer.from(JSON.stringify(saved)), "application/json");
  }
  await options.exportCustomer(saved);
  sendJson(response, 202, await describe(saved));
}
