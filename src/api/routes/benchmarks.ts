import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { REGISTRY_REFERENCE } from "../../contracts/harbor-registry.js";
import type { Benchmark, BenchmarkStore } from "../../db/benchmarks.js";
import type { User } from "../../db/users.js";
import { benchmarkDataset } from "../../evaluation/dataset.js";
import { expandBundle } from "../../generation/runs/bundle.js";
import { readBody } from "../http.js";
import { EVALUATIONS_PATH, handleScopedEvaluations } from "./evaluation-scope.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";
import { openOrgScope, type Reply, unfinishedRuns } from "./org-scope.js";

const NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,98}";
/** `/api/orgs/<org>/benchmarks`, or one benchmark (`<org>/<name>`) and what follows it. */
const route = new RegExp(`^/api/orgs/([A-Za-z0-9_.-]+)/benchmarks(?:/(${NAME}/${NAME})(/.*)?)?$`);

const addSchema = z.strictObject({ reference: z.string() });

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
 * tasks and their files, and its evaluations, served exactly as a repository's are. True when the response
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
  const store = options.benchmarks;
  const opened = await openOrgScope(options, request, response, user, login, !!store);
  if ("sent" in opened || !store) return true;
  const { tenant, send } = opened;
  const context: Context = { options, store, tenant, user, request, url };
  if (!name) return send(await collection(context));

  const benchmark = await store.find(tenant.id, name);
  if (!benchmark) return send([404, { error: "Benchmark not found" }]);
  const evaluations = EVALUATIONS_PATH.exec(rest);
  if (!evaluations) return send(await member(context, benchmark, rest));
  // Its tasks exist once a worker has frozen them; until then there is nothing to run.
  if (benchmark.status !== "ready")
    return send([
      409,
      {
        error:
          benchmark.status === "adding"
            ? "This dataset is still being added"
            : "This dataset couldn't be added",
      },
    ]);
  const [, section, id, action] = evaluations;
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
    tenant,
    dataset: benchmarkDataset(() => store.tasks(benchmark.id)),
    section,
    id,
    action,
    properties: { benchmark: benchmark.name },
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
 * Adds a dataset, `org/name@ref` (`latest` when left out). The box is saved as `adding` and a
 * worker downloads, checks, and freezes every task (selfBenchBenchmarkAddWorkflow), so the API
 * never downloads a task; a dataset a comparison would refuse fails its box with the reason.
 * Adding a failed box again tries again.
 */
async function add({ options, store, tenant, user, request }: Context): Promise<Reply> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(request, 4096)).toString("utf8"));
  } catch {}
  const parsed = addSchema.safeParse(body);
  const match = parsed.success && REGISTRY_REFERENCE.exec(parsed.data.reference);
  if (!match) return [400, { error: "Enter a Harbor registry dataset as org/name@ref" }];
  if (!options.addBenchmark) return [503, { error: "Datasets can't be added here" }];
  const [name, ref] = [`${match[1]}/${match[2]}`, match[3] ?? "latest"];
  const { benchmark, started } = await store.start({
    orgId: tenant.id,
    name,
    ref,
    addedBy: user.id,
  });
  if (!started) return [200, { benchmark }];
  try {
    await options.addBenchmark({ id: benchmark.id, name, ref });
  } catch {
    await store.fail(benchmark.id, "Adding could not start; try again");
    return [503, { error: "Adding could not start; try again" }];
  }
  return [202, { benchmark: (await store.find(tenant.id, name)) ?? benchmark }];
}

/** One benchmark, its removal, its tasks, and a task's files. */
async function member(context: Context, benchmark: Benchmark, rest: string): Promise<Reply> {
  const { options, store, url } = context;
  const method = context.request.method;
  if (rest === "" && method === "GET") return [200, { benchmark }];
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
  const refused = await unfinishedRuns(options, { benchmarkId: benchmark.id }, "benchmark");
  if (refused) return refused;
  await store.remove(tenant.id, benchmark.name);
  return [200, { ok: true }];
}
