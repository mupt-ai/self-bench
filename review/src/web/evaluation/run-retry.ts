import type { EvaluationRun, Harness } from "./api";
import { outcomeOf } from "./results-model";

/** A comparison request that runs a finished run's errored tasks again, as it ran them. */
export interface RetrySelection {
  id: string;
  models: {
    catalogId: string;
    customModel?: string;
    credentialId: string;
    thinking?: EvaluationRun["thinking"];
    harnesses: Harness[];
  }[];
  sandbox: string;
  sandboxCredentialId: string;
  tasks: { runId: string; taskId: string }[];
  /** Leaves out tasks that completed for this setting since, in this run or another. */
  skipCompleted: true;
}

/**
 * The tasks a run's harness errored on, and the comparison that runs them again with the run's
 * model, reasoning, credentials and sandbox. Only a repository's runs: a benchmark's comparison
 * runs its whole dataset (Run Missing Tasks on its Run page). None while the run is live, when it
 * is deleted, when it recorded no credentials (runs from before they did), or when nothing
 * errored.
 */
export function retrySelection(
  run: EvaluationRun,
  harness: Harness,
  id: string,
): { errored: number; selection: RetrySelection } | undefined {
  const { credentials } = run;
  if (
    !credentials ||
    run.repoId === undefined ||
    run.deletedAt ||
    run.status === "queued" ||
    run.status === "running"
  )
    return undefined;
  const errored = run.trials.filter(
    (trial) => trial.harness === harness && outcomeOf(trial) === "error",
  );
  if (errored.length === 0) return undefined;
  const custom = run.model === "custom";
  const managedSandbox = credentials.sandboxCredentialId === "managed-sandbox";
  return {
    errored: errored.length,
    selection: {
      id,
      models: [
        {
          catalogId: run.model,
          // Custom models are recorded as `<provider>/<typed name>` (completedConfigurationTasks).
          ...(custom ? { customModel: run.modelName.replace(/^[^/]+\//, "") } : {}),
          credentialId: credentials.modelCredentialId,
          ...(run.thinking ? { thinking: run.thinking } : {}),
          harnesses: [harness],
        },
      ],
      sandbox: managedSandbox ? "managed" : run.sandbox,
      sandboxCredentialId: credentials.sandboxCredentialId,
      tasks: errored.map(({ runId, taskId }) => ({ runId, taskId })),
      skipCompleted: true,
    },
  };
}
