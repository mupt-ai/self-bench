import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { REGISTRY_REFERENCE } from "../../contracts/harbor-registry.js";
import type { Benchmark, BenchmarkStore } from "../../db/benchmarks.js";
import type { User } from "../../db/users.js";
import { unfinished } from "../../evaluation/comparisons.js";
import { freezeRegistryTasks } from "../../evaluation/frozen-tasks.js";
import { expandBundle } from "../../generation/runs/bundle.js";
import { mergeJudgeNeeds } from "../../harnesses/harbor/host-variables.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import { handleScopedEvaluations } from "./evaluation-scope.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";
import { explainTrial } from "./explain-trial.js";
import { modelSummariesRoute } from "./model-summaries.js";

const NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,98}";
/** `/api/orgs/<org>/benchmarks`, or one benchmark (`<org>/<name>`) and what follows it. */
const route = new RegExp(`^/api/orgs/([A-Za-z0-9_.-]+)/benchmarks(?:/(${NAME}/${NAME})(/.*)?)?$`);
/** What follows a benchmark for its evaluations, as a repository's evaluations take it. */
const evaluationsRoute =
  /^\/evaluations(?:\/(catalog|comparisons|summaries|[a-f0-9-]{36}))?(?:\/(artifacts|[a-f0-9-]{36}))?(?:\/(resume|cancel|delete|explain))?$/;

const addSchema = z.strictObject({ reference: z.string() });

type Reply = readonly [status: number, body: unknown];
const METHOD_NOT_ALLOWED: Reply = [405, { error: "Method not allowed" }];

interface Context {
  options: EvaluationRoutesOptions;
  store: BenchmarkStore;
  tenant: { id: number; login: string };
  user: User;
  request: IncomingMessage;
  url: URL;
}

/**
 * An org's benchmarks: the Harbor registry datasets it added (list, add, remove), each one's
 * tasks and their files, and its evaluations, served like a repository's. True when the response
 * has been sent.
 */
export async function benchmarkRoutes(
  options: EvaluationRoutesOptions,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
): Promise<boolean> {
  const match = route.exec(url.pathname);
  if (!match?.[1]) return false;
  const [, login, name, rest = ""] = match;
  response.setHeader("cache-control", "no-store");
  const send = ([status, body]: Reply) => {
    sendJson(response, status, body);
    request.resume();
    return true;
  };
  const tenant = await tenantFor(options.users, user, login);
  const store = options.benchmarks;
  if (!tenant || !store) return send([404, { error: "Organization not found" }]);
  if (request.method !== "GET" && !trustedMutation(request, options.publicUrl, user))
    return send([403, { error: "Same-origin JSON request required" }]);
  const context: Context = { options, store, tenant, user, request, url };
  if (!name) return send(await collection(context));

  const benchmark = await store.find(tenant.id, name);
  if (!benchmark) return send([404, { error: "Benchmark not found" }]);
  const evaluations = evaluationsRoute.exec(rest);
  if (!evaluations) return send(await member(context, benchmark, rest));
  const [, section, id, action] = evaluations;
  const methods = ["GET", "POST"].includes(request.method ?? "");
  if (section === "summaries" && !id && !action && methods) {
    await modelSummariesRoute(options, request, response, {
      scope: { benchmarkId: benchmark.id },
      orgId: tenant.id,
      user,
      env: options.env ?? process.env,
      tasks: async () =>
        (await store.tasks(benchmark.id)).map(({ runId, taskId, bundleKey }) => ({
          runId,
          taskId,
          bundleKey,
        })),
    });
    request.resume();
    return true;
  }
  if (section && section !== "summaries" && !id && action === "explain" && methods) {
    await explainTrial(options, request, url, response, {
      scope: { benchmarkId: benchmark.id },
      orgId: tenant.id,
      evaluationId: section,
      user,
      env: options.env ?? process.env,
    });
    request.resume();
    return true;
  }
  await handleScopedEvaluations(options, {
    request,
    url,
    response,
    user,
    // A benchmark's tasks run with their own limits, so there is no agent time to set.
    owner: {
      scope: { benchmarkId: benchmark.id },
      orgId: tenant.id,
      tenant: tenant.login,
      login: user.login,
    },
    benchmark,
    tenant,
    section,
    id,
    action,
  });
  return true;
}

/** The org's benchmarks: listed, or one more added. */
async function collection(context: Context): Promise<Reply> {
  if (context.request.method === "GET")
    return [200, { benchmarks: await context.store.list(context.tenant.id) }];
  if (context.request.method === "POST") return add(context);
  return METHOD_NOT_ALLOWED;
}

/**
 * Adds a dataset, `org/name@ref` (`latest` when left out). Every task is downloaded, checked, and
 * frozen first, so a dataset a comparison would refuse is refused here, and its Dataset tab shows
 * exactly what was checked.
 */
async function add({ options, store, tenant, user, request }: Context): Promise<Reply> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(request, 4096)).toString("utf8"));
  } catch {}
  const parsed = addSchema.safeParse(body);
  const match = parsed.success && REGISTRY_REFERENCE.exec(parsed.data.reference);
  if (!match) return [400, { error: "Enter a Harbor registry dataset as org/name@ref" }];
  const [name, ref] = [`${match[1]}/${match[2]}`, match[3] ?? "latest"];
  const existing = await store.find(tenant.id, name);
  if (existing) return [200, { benchmark: existing }];
  try {
    const taskList = await freezeRegistryTasks(
      options.artifacts,
      [`${name}@${ref}`],
      options.env ?? process.env,
      options.registryCommand,
    );
    const saved = await store.add({ orgId: tenant.id, name, ref, taskList, addedBy: user.id });
    return [saved.added ? 201 : 200, { benchmark: saved.benchmark }];
  } catch (error) {
    return [400, { error: error instanceof Error ? error.message : "Dataset could not be added" }];
  }
}

/** One benchmark (with what its LLM judge reads), its removal, its tasks, and a task's files. */
async function member(context: Context, benchmark: Benchmark, rest: string): Promise<Reply> {
  const { options, store, url } = context;
  const method = context.request.method;
  if (rest === "" && method === "GET") {
    const judge = mergeJudgeNeeds((await store.tasks(benchmark.id)).map((task) => task.judge));
    return [200, { benchmark: { ...benchmark, judge } }];
  }
  if (rest === "" && method === "DELETE") return remove(context, benchmark);
  if (rest === "/tasks" && method === "GET") {
    const tasks = (await store.tasks(benchmark.id)).map(({ runId, taskId, registry }) => ({
      runId,
      taskId,
      registry,
    }));
    return [200, { tasks }];
  }
  if (rest === "/task-files" && method === "GET") {
    // The bundle frozen when the benchmark was added.
    const wanted = url.searchParams.get("task");
    const task = (await store.tasks(benchmark.id)).find((entry) => entry.taskId === wanted);
    return task
      ? [200, await expandBundle(options.artifacts, task.bundleKey)]
      : [404, { error: "Task not found" }];
  }
  return ["", "/tasks", "/task-files"].includes(rest)
    ? METHOD_NOT_ALLOWED
    : [404, { error: "Not found" }];
}

/**
 * Removes a benchmark once none of its comparisons is unfinished: its runs are followed and
 * cancelled only through it.
 */
async function remove({ options, store, tenant }: Context, benchmark: Benchmark): Promise<Reply> {
  const records = options.vault
    ? await options.vault.comparisons.listForScope({ benchmarkId: benchmark.id })
    : [];
  const active = await Promise.all(records.map((record) => unfinished(options.artifacts, record)));
  if (active.includes(true))
    return [409, { error: "Cancel this benchmark's unfinished comparisons before removing it" }];
  await store.remove(tenant.id, benchmark.name);
  return [200, { ok: true }];
}
