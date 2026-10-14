import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { REGISTRY_REFERENCE } from "../../contracts/harbor-registry.js";
import type { Benchmark } from "../../db/benchmarks.js";
import type { User } from "../../db/users.js";
import { unfinished } from "../../evaluation/comparisons.js";
import { freezeRegistryTasks } from "../../evaluation/frozen-tasks.js";
import { expandBundle } from "../../generation/runs/bundle.js";
import { mergeJudgeNeeds } from "../../harnesses/harbor/host-variables.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import { handleScopedEvaluations } from "./evaluation-scope.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

const ORG = "([A-Za-z0-9_.-]+)";
const NAME = "([A-Za-z0-9][A-Za-z0-9._-]{0,98})";
const listRoute = new RegExp(`^/api/orgs/${ORG}/benchmarks$`);
const itemRoute = new RegExp(
  `^/api/orgs/${ORG}/benchmarks/${NAME}/${NAME}(?:/(tasks|task-files))?$`,
);
const evaluationRoute = new RegExp(
  `^/api/orgs/${ORG}/benchmarks/${NAME}/${NAME}/evaluations(?:/(catalog|comparisons|[a-f0-9-]{36}))?(?:/(artifacts|[a-f0-9-]{36}))?(?:/(resume|cancel))?$`,
);
const addSchema = z.strictObject({ reference: z.string().regex(REGISTRY_REFERENCE) });

/**
 * An org's benchmarks: the Harbor registry datasets it added (list, add, remove), each one's
 * tasks and their files, and its evaluations, served like a repository's. Adding a dataset
 * downloads, checks, and freezes every task, so one a comparison would refuse is refused here, and
 * its Dataset tab shows exactly what was checked. True when the response has been sent.
 */
export async function benchmarkRoutes(
  options: EvaluationRoutesOptions,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
): Promise<boolean> {
  const list = listRoute.exec(url.pathname);
  const item = list ? undefined : itemRoute.exec(url.pathname);
  const evaluations = list || item ? undefined : evaluationRoute.exec(url.pathname);
  const login = (list ?? item ?? evaluations)?.[1];
  if (!login) return false;
  response.setHeader("cache-control", "no-store");
  const tenant = await tenantFor(options.users, user, login);
  const store = options.benchmarks;
  if (!tenant || !store) {
    sendJson(response, 404, { error: "Organization not found" });
    return true;
  }
  if (request.method !== "GET" && !trustedMutation(request, options.publicUrl, user)) {
    sendJson(response, 403, { error: "Same-origin JSON request required" });
    return true;
  }
  if (list) {
    if (request.method === "GET") {
      sendJson(response, 200, { benchmarks: await store.list(tenant.id) });
    } else if (request.method === "POST") {
      const parsed = addSchema.safeParse(
        JSON.parse((await readBody(request, 4096)).toString("utf8") || "{}"),
      );
      const match = parsed.success ? REGISTRY_REFERENCE.exec(parsed.data.reference) : null;
      if (!match) {
        sendJson(response, 400, { error: "Enter a Harbor registry dataset as org/name@ref" });
      } else {
        const [name, ref] = [`${match[1]}/${match[2]}`, match[3] ?? "latest"];
        const existing = await store.find(tenant.id, name);
        if (existing) sendJson(response, 200, { benchmark: existing });
        else {
          try {
            const taskList = await freezeRegistryTasks(
              options.artifacts,
              [`${name}@${ref}`],
              options.env ?? process.env,
              options.registryCommand,
            );
            const { benchmark, added } = await store.add({
              orgId: tenant.id,
              name,
              ref,
              taskList,
              addedBy: user.id,
            });
            sendJson(response, added ? 201 : 200, { benchmark });
          } catch (error) {
            sendJson(response, 400, {
              error: error instanceof Error ? error.message : "Dataset could not be added",
            });
          }
        }
      }
    } else sendJson(response, 405, { error: "Method not allowed" });
    request.resume();
    return true;
  }
  const [, , owner, name] = (item ?? evaluations) as RegExpExecArray;
  const benchmark = await store.find(tenant.id, `${owner}/${name}`);
  if (!benchmark) {
    sendJson(response, 404, { error: "Benchmark not found" });
    request.resume();
    return true;
  }
  if (item?.[4] && request.method === "GET") {
    const tasks = await store.tasks(benchmark.id);
    if (item[4] === "tasks")
      sendJson(response, 200, {
        tasks: tasks.map(({ runId, taskId, registry }) => ({ runId, taskId, registry })),
      });
    else {
      // One task's files, for its page: the bundle frozen when the benchmark was added.
      const task = tasks.find((entry) => entry.taskId === url.searchParams.get("task"));
      if (task) sendJson(response, 200, await expandBundle(options.artifacts, task.bundleKey));
      else sendJson(response, 404, { error: "Task not found" });
    }
    return true;
  }
  if (item) {
    if (request.method === "GET" && !item[4]) {
      // The judge variables its tasks read, so the Run page can ask for a judge credential.
      const judge = mergeJudgeNeeds((await store.tasks(benchmark.id)).map((task) => task.judge));
      sendJson(response, 200, { benchmark: { ...benchmark, judge } });
    } else if (request.method === "DELETE" && !item[4]) {
      // Its runs are reached only through the benchmark, so it stays until none are unfinished.
      const scope = { benchmarkId: benchmark.id };
      const records = options.vault ? await options.vault.comparisons.listForScope(scope) : [];
      const active = await Promise.all(
        records.map((record) => unfinished(options.artifacts, record)),
      );
      if (active.includes(true))
        sendJson(response, 409, {
          error: "Cancel this benchmark's unfinished comparisons before removing it",
        });
      else {
        await store.remove(tenant.id, benchmark.name);
        sendJson(response, 200, { ok: true });
      }
    } else sendJson(response, 405, { error: "Method not allowed" });
    request.resume();
    return true;
  }
  const match = evaluations as RegExpExecArray;
  await handleScopedEvaluations(options, {
    request,
    url,
    response,
    user,
    owner: ownerOf(benchmark, tenant, user),
    benchmark,
    tenant,
    section: match[4],
    id: match[5],
    action: match[6],
  });
  return true;
}

function ownerOf(benchmark: Benchmark, tenant: { id: number; login: string }, user: User) {
  return {
    // A benchmark's tasks run with their own limits, so there is no agent time to set.
    scope: { benchmarkId: benchmark.id },
    orgId: tenant.id,
    tenant: tenant.login,
    login: user.login,
  };
}
