import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ConnectedRepo } from "../../db/repos.js";
import type { User } from "../../db/users.js";
import { explainable } from "../../evaluation/failure-summary.js";
import { harnessIds } from "../../evaluation/models.js";
import { getEvaluation } from "../../evaluation/store.js";
import { trialInput } from "../../evaluation/trial-input.js";
import { managedOffer } from "../../generation/billing/managed.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

const trialSchema = z
  .object({ runId: z.string().min(1), taskId: z.string().min(1), harness: z.enum(harnessIds) })
  .strict();

/**
 * `POST …/evaluations/<id>/explain`: explains one trial of the evaluation that failed its tests,
 * named by its task and harness, when someone asks (Explain Failure in the app). Asking is consent
 * for that trial's material to reach the summary model through SelfBench's account, whatever the
 * repository; it needs the platform's managed models. Responds 202 once the explanation started.
 */
export async function explainTrial(
  options: Pick<EvaluationRoutesOptions, "artifacts" | "tasks" | "vault" | "publicUrl" | "explain">,
  request: IncomingMessage,
  response: ServerResponse,
  context: { repo: ConnectedRepo; evaluationId: string; user: User; env: NodeJS.ProcessEnv },
): Promise<void> {
  const { repo, evaluationId, user, env } = context;
  if (!trustedMutation(request, options.publicUrl, user)) {
    sendJson(response, 403, { error: "Same-origin JSON request required" });
    return;
  }
  if (!options.explain || !managedOffer(env).models) {
    sendJson(response, 409, {
      error: "Failure explanations need SelfBench's managed models, which this deployment lacks.",
    });
    return;
  }
  let identity: z.infer<typeof trialSchema>;
  try {
    identity = trialSchema.parse(JSON.parse((await readBody(request, 4_096)).toString()));
  } catch {
    sendJson(response, 400, { error: "Name the trial by its runId, taskId and harness." });
    return;
  }
  const run = await getEvaluation(options.artifacts, repo.id, evaluationId);
  const index =
    run?.trials.findIndex(
      (trial) =>
        trial.runId === identity.runId &&
        trial.taskId === identity.taskId &&
        trial.harness === identity.harness,
    ) ?? -1;
  const trial = run?.trials[index];
  if (!run || !trial) {
    sendJson(response, 404, { error: "Trial not found" });
    return;
  }
  if (!explainable(trial)) {
    sendJson(response, 409, {
      error: "Only a trial that failed its tests and has no explanation yet can be explained.",
    });
    return;
  }
  // The bundle the trial ran, as its comparison froze it; the task's current one otherwise.
  const record = run.comparisonId
    ? await options.vault?.comparisons.find(run.comparisonId)
    : undefined;
  const frozen =
    record?.repoId === repo.id ? record.inputs.find((input) => input.id === run.id) : undefined;
  const bundleKey =
    (frozen && trialInput(frozen, index).tasks[0]?.bundleKey) ??
    (await options.tasks.find(repo.id, trial.runId, trial.taskId))?.bundleKey;
  await options.explain({
    repoId: repo.id,
    id: run.id,
    index,
    ...(bundleKey ? { bundleKey } : {}),
  });
  sendJson(response, 202, {});
}
