import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ConnectedRepo } from "../../db/repos.js";
import type { User } from "../../db/users.js";
import { materialKey } from "../../evaluation/failure-material.js";
import { explainable } from "../../evaluation/failure-summary.js";
import { harnessIds } from "../../evaluation/models.js";
import { getEvaluation } from "../../evaluation/store.js";
import { trialInput } from "../../evaluation/trial-input.js";
import type { FailedTrial } from "../../evaluation/types.js";
import { managedOffer } from "../../generation/billing/managed.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

/** How long after an explanation ended without one the same trial may be asked again. */
const RETRY_AFTER_MS = 10 * 60_000;

const trialSchema = z
  .object({ runId: z.string().min(1), taskId: z.string().min(1), harness: z.enum(harnessIds) })
  .strict();

type Options = Pick<EvaluationRoutesOptions, "artifacts" | "vault" | "publicUrl" | "explain">;
interface Context {
  repo: ConnectedRepo;
  evaluationId: string;
  user: User;
  env: NodeJS.ProcessEnv;
}

/**
 * `…/evaluations/<id>/explain`, for one trial of the evaluation named by its task and harness
 * (Explain Failure in the app). GET tells whether it can be explained, whether it is being, and
 * whether it already was (since the page holding the run read it);
 * POST starts it and answers 202. Asking is consent for that trial's material to reach the
 * summary model through SelfBench's account, whatever the repository. It needs the platform's
 * managed models, a trial that failed its tests with no explanation yet, and either material the
 * trial kept or the bundle its comparison froze; a trial whose last explanation just ended without
 * one waits a few minutes.
 */
export async function explainTrial(
  options: Options,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  context: Context,
): Promise<void> {
  if (request.method === "POST" && !trustedMutation(request, options.publicUrl, context.user)) {
    sendJson(response, 403, { error: "Same-origin JSON request required" });
    return;
  }
  let identity: z.infer<typeof trialSchema>;
  try {
    identity = trialSchema.parse(
      request.method === "POST"
        ? JSON.parse((await readBody(request, 4_096)).toString())
        : Object.fromEntries(url.searchParams),
    );
  } catch {
    sendJson(response, 400, { error: "Name the trial by its runId, taskId and harness." });
    return;
  }
  const found = await explainableTrial(options, context, identity);
  if ("status" in found) {
    if (request.method === "GET" && found.status !== 404)
      sendJson(response, 200, {
        available: false,
        running: false,
        reason: found.error,
        ...(found.explained ? { explained: true } : {}),
      });
    else sendJson(response, found.status, { error: found.error });
    return;
  }
  const { trial, explainer } = found;
  const { running, endedAt } = await explainer.state(trial);
  const waiting = !running && endedAt !== undefined && Date.now() - endedAt < RETRY_AFTER_MS;
  const reason = "Its last explanation just ended without one. Try again in a few minutes.";
  if (request.method === "GET") {
    sendJson(response, 200, { available: !waiting, running, ...(waiting ? { reason } : {}) });
    return;
  }
  if (waiting) {
    sendJson(response, 429, { error: reason });
    return;
  }
  if (!running) await explainer.start(trial);
  sendJson(response, 202, {});
}

async function explainableTrial(
  options: Options,
  { repo, evaluationId, env }: Context,
  identity: z.infer<typeof trialSchema>,
): Promise<
  | { trial: FailedTrial; explainer: NonNullable<Options["explain"]> }
  | { status: number; error: string; explained?: boolean }
> {
  if (!options.explain || !managedOffer(env).models)
    return {
      status: 409,
      error: "Failure explanations need SelfBench's managed models, which this deployment lacks.",
    };
  const run = await getEvaluation(options.artifacts, repo.id, evaluationId);
  const index =
    run?.trials.findIndex(
      (trial) =>
        trial.runId === identity.runId &&
        trial.taskId === identity.taskId &&
        trial.harness === identity.harness,
    ) ?? -1;
  const trial = run?.trials[index];
  if (!run || !trial) return { status: 404, error: "Trial not found" };
  if (!explainable(trial))
    return {
      status: 409,
      error: "Only a trial that failed its tests and has no explanation yet can be explained.",
      ...(trial.failureSummary ? { explained: true } : {}),
    };
  // The bundle the trial ran, as its comparison froze it; a later bundle has other tests.
  const record = run.comparisonId
    ? await options.vault?.comparisons.find(run.comparisonId)
    : undefined;
  const frozen =
    record?.repoId === repo.id ? record.inputs.find((input) => input.id === run.id) : undefined;
  const bundleKey = frozen && trialInput(frozen, index).tasks[0]?.bundleKey;
  const failed = { repoId: repo.id, id: run.id, index };
  if (!bundleKey && !(await options.artifacts.stat(materialKey(failed))))
    return { status: 409, error: "This trial's task was not recorded, so it can't be explained." };
  return { trial: { ...failed, ...(bundleKey ? { bundleKey } : {}) }, explainer: options.explain };
}
