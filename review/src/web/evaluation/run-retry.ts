import type { CredentialInfo } from "../../../../src/db/credentials";
import { hostedSandboxes } from "../../../../src/evaluation/catalog";
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
  /** The sandbox credential to retry on: a saved one's id, or `managed-sandbox`; else the run's. */
  sandboxCredentialId?: string,
  saved: readonly Pick<CredentialInfo, "id" | "kind">[] = [],
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
  const sandboxId = sandboxCredentialId ?? credentials.sandboxCredentialId;
  const managedSandbox = sandboxId === "managed-sandbox";
  const kind = saved.find((credential) => credential.id === sandboxId)?.kind;
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
      sandbox: managedSandbox ? "managed" : (kind ?? run.sandbox),
      sandboxCredentialId: sandboxId,
      tasks: errored.map(({ runId, taskId }) => ({ runId, taskId })),
      skipCompleted: true,
    },
  };
}

/**
 * The sandboxes a retry may run on: the org's saved sandbox credentials, and managed sandboxes when
 * the run used them. The run's own comes first when it still exists. An empty list may just not
 * have loaded, so the run's own bring-your-own sandbox is kept then, and the server has the final
 * say on it.
 */
export function retrySandboxes(
  run: EvaluationRun,
  saved: readonly CredentialInfo[],
): { id: string; label: string }[] {
  const names: Record<string, string> = { e2b: "E2B", modal: "Modal", daytona: "Daytona" };
  const own = run.credentials?.sandboxCredentialId;
  const listed = saved
    .filter((credential) => (hostedSandboxes as readonly string[]).includes(credential.kind))
    .map((credential) => ({
      id: credential.id,
      label: `${names[credential.kind] ?? credential.kind} · ${credential.name}`,
    }));
  const unknown = own !== undefined && own !== "managed-sandbox" && saved.length === 0;
  const choices = [
    ...(own === "managed-sandbox" ? [{ id: "managed-sandbox", label: "Managed" }] : []),
    ...(unknown
      ? [{ id: own, label: `${names[run.sandbox] ?? run.sandbox} · Run's Credential` }]
      : []),
    ...listed,
  ];
  const isOwn = (choice: { id: string }) => choice.id === own;
  return [...choices.filter(isOwn), ...choices.filter((choice) => !isOwn(choice))];
}
