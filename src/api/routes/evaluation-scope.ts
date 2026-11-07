import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { ComparisonRecord } from "../../db/comparisons.js";
import { RecordStoreError } from "../../db/encrypted-records.js";
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
  type ComparisonOwner,
  comparisonSchema,
  comparisonStatus,
  createComparison,
  dispatchComparison,
} from "../../evaluation/comparisons.js";
import type { EvaluationDataset } from "../../evaluation/dataset.js";
import { evaluationTaskKey } from "../../evaluation/models.js";
import { listRuns } from "../../evaluation/run-list.js";
import { sameScope } from "../../evaluation/scope.js";
import { runScope, scopedRun, scopedRuns } from "../../evaluation/scoped-runs.js";
import { evaluationPrefix, getEvaluation, live } from "../../evaluation/store.js";
import { managedHarborEnvironment, managedOffer } from "../../generation/billing/managed.js";
import { track } from "../../lib/telemetry/posthog.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import { auditTaskRoute } from "./audit-task.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";
import { explainTrial } from "./explain-trial.js";
import { modelSummariesRoute } from "./model-summaries.js";
import { resultsRoute } from "./results.js";

/** EVALUATIONS_PATH's named sections, which are never a run's id. */
const SECTIONS = new Set([
  "options",
  "catalog",
  "comparisons",
  "audit",
  "summaries",
  "results",
  "exports",
]);

/**
 * What follows a repository or benchmark for its evaluations: the catalog, the tasks to pick from,
 * comparisons, task audits, model summaries, results, customer exports (a repository's only), and runs with
 * their artifacts and actions.
 */
export const EVALUATIONS_PATH =
  /^\/evaluations(?:\/(options|catalog|comparisons|audit|summaries|results|exports|[a-f0-9-]{36}))?(?:\/(artifacts|[a-f0-9-]{36}))?(?:\/(resume|cancel|delete|explain|download|revoke))?$/;

/** A request under a repository's evaluations or a benchmark's. */
export interface ScopedRequest {
  request: IncomingMessage;
  url: URL;
  response: ServerResponse;
  user: User;
  owner: ComparisonOwner;
  tenant: { id: number; login: string };
  /** What the scope's evaluations run on: the only way a repository's differ from a benchmark's. */
  dataset: EvaluationDataset;
  /** The parts of EVALUATIONS_PATH the request matched. */
  section: string | undefined;
  id: string | undefined;
  action: string | undefined;
  /** What a started comparison's telemetry adds, such as the benchmark's name. */
  properties?: Record<string, string>;
}

/**
 * Serves one repository's or benchmark's evaluations, the same way for both: the catalog, the
 * tasks to pick from, comparisons (create, list, status, resume, cancel), task audits, model
 * summaries, failure explanations, and runs with their artifacts. Only what a comparison runs on
 * differs, and `dataset` says that.
 */
export async function handleScopedEvaluations(
  options: EvaluationRoutesOptions,
  scoped: ScopedRequest,
): Promise<void> {
  const { request, url, response, user, owner, dataset, tenant, section, id, action } = scoped;
  const { artifacts } = options;
  const { scope, orgId } = owner;
  const env = options.env ?? process.env;
  const methods = ["GET", "POST"].includes(request.method ?? "");
  if (section === "audit" && !id && !action && methods) {
    await auditTaskRoute(options, request, url, response, { scope, orgId, user, env });
    request.resume();
    return;
  }
  if (section === "summaries" && !id && !action && methods) {
    await modelSummariesRoute(options, request, response, {
      scope,
      orgId,
      user,
      env,
      tasks: () => dataset.summaryTasks(),
    });
    request.resume();
    return;
  }
  if (section && !SECTIONS.has(section) && !id && action === "explain" && methods) {
    await explainTrial(options, request, url, response, {
      // A group's member run is explained where it lives, in its repository.
      scope: (await runScope(artifacts, scope, dataset, section)) ?? scope,
      orgId,
      evaluationId: section,
      user,
      env,
    });
    request.resume();
    return;
  }
  if (section === "exports") {
    sendJson(response, 404, { error: "Not found" });
    request.resume();
    return;
  }
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
          // Every evaluation of a comparison carries the same list (assertTasksFitSandbox).
          resourceWarnings: record.inputs[0]?.resourceWarnings ?? [],
        });
        return !submissionError;
      };
      if (request.method === "POST" && !id) {
        const body = JSON.parse((await readBody(request, 30_000)).toString());
        const draft = comparisonSchema.parse(body);
        const record = await createComparison(
          vault,
          dataset,
          artifacts,
          managedOffer(env),
          owner,
          draft,
          env,
        );
        const submitted = await resume(
          record,
          "Comparison saved. Some submissions were not confirmed; resume safely using this comparison.",
        );
        track(
          user,
          scope.repoId !== undefined ? "comparison started" : "benchmark started",
          {
            tasks: new Set(
              record.inputs.flatMap((input) =>
                input.tasks.map((task) => evaluationTaskKey(task.runId, task.taskId)),
              ),
            ).size,
            ...scoped.properties,
            models: draft.models.length,
            harnesses: draft.models.reduce((sum, model) => sum + model.harnesses.length, 0),
            sandbox: draft.sandbox,
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
  if (section === "results") {
    await resultsRoute(artifacts, url, response, scope, dataset);
  } else if (section === "catalog") {
    sendJson(response, 200, {
      version: catalogVersion,
      models: evaluationCatalog().map(withReferencePricing),
      sandboxes: hostedSandboxes,
      customHosts: (env.SELFBENCH_CUSTOM_MODEL_HOSTS ?? "").split(",").filter(Boolean),
      managed: { ...managedOffer(env), sandbox: managedHarborEnvironment(env) === "modal" },
    });
  } else if (section === "options") {
    sendJson(response, 200, await dataset.options());
  } else if (section) {
    // A group shows its members' runs too, so one may be opened from it.
    const run = await scopedRun(artifacts, scope, dataset, section);
    if (!run) sendJson(response, 404, { error: "Evaluation not found" });
    else if (id === "artifacts") await sendArtifact(artifacts, run, url, response);
    else if (!id) sendJson(response, 200, run);
    else sendJson(response, 404, { error: "Not found" });
  } else {
    // A page polling this list sends back the tag of the one it has, and is told when that list
    // still stands without being sent it again.
    const have = /^(?:W\/)?"([^"]+)"$/.exec(request.headers["if-none-match"] ?? "")?.[1];
    // A dataset that hides some trials tags its own view, so only one that hides none can answer
    // from the stored list's tag alone.
    const listed = await scopedRuns(artifacts, scope, dataset, dataset.visible ? undefined : have);
    const visible = await dataset.visible?.(listed.runs ?? []);
    const tag = visible?.tag
      ? createHash("sha256").update(`${listed.tag}.${visible.tag}`).digest("base64url").slice(0, 27)
      : listed.tag;
    const runs = tag === have ? undefined : (visible?.runs ?? listed.runs);
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
