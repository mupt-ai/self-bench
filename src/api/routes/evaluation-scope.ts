import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { Benchmark } from "../../db/benchmarks.js";
import type { ComparisonRecord } from "../../db/comparisons.js";
import { RecordStoreError } from "../../db/encrypted-records.js";
import { runnable } from "../../db/task-record.js";
import type { User } from "../../db/users.js";
import { cancelComparison, cancelEvaluation, deleteEvaluation } from "../../evaluation/cancel.js";
import {
  catalogVersion,
  evaluationCatalog,
  hostedSandboxes,
  withReferencePricing,
} from "../../evaluation/catalog.js";
import { comparisonProgress } from "../../evaluation/comparison-progress.js";
import {
  benchmarkComparisonSchema,
  type ComparisonOwner,
  type ComparisonSelection,
  comparisonSchema,
  comparisonStatus,
  createBenchmarkComparison,
  createComparison,
  dispatchComparison,
} from "../../evaluation/comparisons.js";
import { listRuns } from "../../evaluation/run-list.js";
import { sameScope } from "../../evaluation/scope.js";
import { evaluationPrefix, getEvaluation, live } from "../../evaluation/store.js";
import { managedHarborEnvironment, managedOffer } from "../../generation/billing/managed.js";
import { track } from "../../lib/telemetry/posthog.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

/** A matched request under a repository's evaluations or a benchmark's. */
export interface ScopedRequest {
  request: IncomingMessage;
  url: URL;
  response: ServerResponse;
  user: User;
  owner: ComparisonOwner;
  /** The benchmark whose evaluations these are, when they are not a repository's. */
  benchmark?: Benchmark;
  tenant: { id: number; login: string };
  section: string | undefined;
  id: string | undefined;
  action: string | undefined;
}

/**
 * Serves one repository's or benchmark's evaluations: the catalog, comparisons (create, list,
 * status, resume, cancel), and runs with their artifacts. The two differ only in what a comparison
 * runs: a repository's approved tasks, or the benchmark's Harbor registry dataset.
 */
export async function handleScopedEvaluations(
  options: EvaluationRoutesOptions,
  scoped: ScopedRequest,
): Promise<void> {
  const { request, url, response, user, owner, benchmark, tenant, section, id, action } = scoped;
  const { artifacts } = options;
  const { scope } = owner;
  const env = options.env ?? process.env;
  if (section === "comparisons") {
    if (
      request.method !== "GET" &&
      (request.method !== "POST" || !trustedMutation(request, options.publicUrl, user))
    ) {
      sendJson(response, 403, { error: "Same-origin JSON request required" });
      return;
    }
    try {
      if (!options.vault) throw new RecordStoreError(503);
      const vault = options.vault;
      const resume = async (record: ComparisonRecord, message: string) => {
        let submissionError: string | undefined;
        try {
          await dispatchComparison(artifacts, record, options.start);
        } catch {
          submissionError = message;
        }
        sendJson(response, 202, {
          ...(await comparisonStatus(artifacts, record)),
          submissionError,
        });
        return !submissionError;
      };
      if (request.method === "POST" && !id) {
        const body = JSON.parse((await readBody(request, 30_000)).toString());
        let selected: ComparisonSelection & { tasks: number };
        let record: ComparisonRecord;
        if (scope.repoId !== undefined) {
          const draft = comparisonSchema.parse(body);
          selected = { ...draft, tasks: draft.tasks.length };
          record = await createComparison(
            vault,
            options.tasks,
            artifacts,
            managedOffer(env),
            { ...owner, scope: { repoId: scope.repoId } },
            draft,
            env,
            options.fetch,
          );
        } else if (benchmark && options.benchmarks && scope.benchmarkId !== undefined) {
          const draft = benchmarkComparisonSchema.parse(body);
          selected = { ...draft, tasks: benchmark.tasks };
          record = await createBenchmarkComparison(
            vault,
            artifacts,
            managedOffer(env),
            { ...owner, scope: { benchmarkId: scope.benchmarkId } },
            await options.benchmarks.tasks(benchmark.id),
            draft,
            env,
            options.fetch,
          );
        } else throw new Error("Benchmark not found");
        const submitted = await resume(
          record,
          "Comparison saved. Some submissions were not confirmed; resume safely using this comparison.",
        );
        track(
          user,
          scope.repoId !== undefined ? "comparison started" : "benchmark started",
          {
            tasks: selected.tasks,
            ...(benchmark ? { benchmark: benchmark.name } : {}),
            models: selected.models.length,
            harnesses: selected.models.reduce((sum, model) => sum + model.harnesses.length, 0),
            sandbox: selected.sandbox,
            // False when some runs were not confirmed; resuming submits them later.
            submitted,
          },
          tenant,
        );
      } else if (request.method === "GET" && !id) {
        const records = await vault.comparisons.listForScope(scope);
        // One read of the scope's run summaries serves every comparison.
        const { runs = [] } = records.length ? await listRuns(artifacts, scope) : {};
        const byId = new Map(runs.map((run) => [run.id, run]));
        sendJson(response, 200, {
          comparisons: records.map((record) => comparisonProgress(record, byId)),
        });
      } else {
        const record = id ? await vault.comparisons.find(id) : undefined;
        if (!record || record.orgId !== tenant.id || !sameScope(record.scope, scope))
          sendJson(response, 404, { error: "Comparison not found" });
        else if (request.method === "GET" && !action)
          sendJson(response, 200, await comparisonStatus(artifacts, record));
        else if (request.method === "POST" && action === "resume")
          await resume(record, "Submission not confirmed. Resume uses the same run IDs.");
        else if (request.method === "POST" && action === "cancel") {
          await cancelComparison(artifacts, record, user.login, options.stop);
          sendJson(response, 200, await comparisonStatus(artifacts, record));
        } else sendJson(response, 405, { error: "Method not allowed" });
      }
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
    return;
  }
  if (section && !id && (action === "cancel" || action === "delete") && request.method === "POST") {
    const trusted = trustedMutation(request, options.publicUrl, user);
    const run = trusted ? await getEvaluation(artifacts, scope, section) : undefined;
    if (!trusted) sendJson(response, 403, { error: "Same-origin JSON request required" });
    else if (!run || (action === "cancel" && run.deletedAt))
      sendJson(response, 404, { error: "Evaluation not found" });
    else if (action === "delete")
      sendJson(
        response,
        200,
        await deleteEvaluation(artifacts, scope, section, user.login, options.stop),
      );
    else {
      await cancelEvaluation(artifacts, scope, section, user.login, options.stop);
      sendJson(response, 200, await getEvaluation(artifacts, scope, section));
    }
    request.resume();
    return;
  }
  if (request.method !== "GET" || action) {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (section === "catalog") {
    sendJson(response, 200, {
      version: catalogVersion,
      models: evaluationCatalog().map(withReferencePricing),
      sandboxes: hostedSandboxes,
      customHosts: (env.SELFBENCH_CUSTOM_MODEL_HOSTS ?? "").split(",").filter(Boolean),
      managed: { ...managedOffer(env), sandbox: managedHarborEnvironment(env) === "modal" },
    });
  } else if (section === "options" && scope.repoId !== undefined) {
    // Only a repository has tasks to choose from; a benchmark's come from Harbor's registry.
    const available = (await options.tasks.listForRepo(scope.repoId)).filter(runnable);
    sendJson(response, 200, {
      tasks: available.map(({ runId, taskId, difficulty }) => ({ runId, taskId, difficulty })),
    });
  } else if (section) {
    const run = await getEvaluation(artifacts, scope, section);
    if (!run) sendJson(response, 404, { error: "Evaluation not found" });
    else if (id === "artifacts") await sendArtifact(artifacts, run, url, response);
    else if (!id) sendJson(response, 200, run);
    else sendJson(response, 404, { error: "Not found" });
  } else {
    // A page polling this list sends back the tag of the one it has, and is told when that list
    // still stands without being sent it again.
    const have = /^(?:W\/)?"([^"]+)"$/.exec(request.headers["if-none-match"] ?? "")?.[1];
    const { tag, runs } = await listRuns(artifacts, scope, have);
    response.setHeader("etag", `"${tag}"`);
    if (runs) sendJson(response, 200, { runs: runs.filter(live) });
    else response.writeHead(304).end();
  }
}

async function sendArtifact(
  artifacts: ArtifactStore,
  run: NonNullable<Awaited<ReturnType<typeof getEvaluation>>>,
  url: URL,
  response: ServerResponse,
) {
  const name = url.searchParams.get("name") ?? "";
  const bytes = run.trials.some((trial) => trial.artifacts.includes(name))
    ? await artifacts.getByKey(`${evaluationPrefix(run, run.id)}artifacts/${name}`)
    : undefined;
  if (!bytes) {
    sendJson(response, 404, { error: "Artifact not found" });
    return;
  }
  response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "content-disposition": "attachment; filename=solver-artifact.txt",
  });
  response.end(bytes);
}
