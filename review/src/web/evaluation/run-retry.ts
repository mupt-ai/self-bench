import type { HarnessOptions } from "../../../../src/contracts/harness-options";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { type CatalogModel, hostedSandboxes } from "../../../../src/evaluation/catalog";
import { credentialRunsHarness, routeFor } from "../../../../src/evaluation/models";
import type { EvaluationRun, Harness } from "./api";
import { isSandbox } from "./credential-presentation";
import { outcomeOf } from "./results-model";

/** A comparison request that runs a finished run's errored or cancelled tasks again, as it ran them. */
export interface RetrySelection {
  id: string;
  models: {
    catalogId: string;
    customModel?: string;
    credentialId: string;
    thinking?: EvaluationRun["thinking"];
    subagent?: { catalogId: string; credentialId: string };
    harnesses: Harness[];
  }[];
  sandbox: string;
  sandboxCredentialId: string;
  tasks: { runId: string; taskId: string }[];
  /** The LLM judge's credential, as the run recorded it, for tasks graded by one. */
  judgeCredentialId?: string;
  /** Leaves out tasks that completed for this setting since, in this run or another. */
  skipCompleted: true;
  /** A run under a condition retries under it alone, as it ran it, not the tasks as they are too. */
  conditions?: {
    name: string;
    skills: string[];
    instructions?: string;
    environment?: number;
    harnessOptions?: HarnessOptions;
    subagent?: { catalogId: string; prompt: string; thinking?: string; credentialId?: string };
  }[];
  baseline?: false;
}

/**
 * The tasks a run's harness errored on or that were cancelled before they finished, and the comparison that runs them again with the run's
 * model, reasoning, credentials and sandbox, in its repository or benchmark alike. None while the
 * run is live, when it is deleted, when it recorded no credentials (runs from before they did), or
 * when nothing errored or was cancelled.
 */
export function retrySelection(
  run: EvaluationRun,
  harness: Harness,
  id: string,
  /** The sandbox credential to retry on: a saved one's id, or `managed-sandbox`; else the run's. */
  sandboxCredentialId?: string,
  saved: readonly Pick<CredentialInfo, "id" | "kind">[] = [],
  /** The model credential to retry on, when not the one the run used. */
  modelCredentialId?: string,
): { errored: number; cancelled: number; selection: RetrySelection } | undefined {
  const { credentials } = run;
  if (!credentials || run.deletedAt || run.status === "queued" || run.status === "running")
    return undefined;
  const outcomes = run.trials
    .filter((trial) => trial.harness === harness)
    .map((trial) => ({ trial, outcome: outcomeOf(trial) }));
  const retried = outcomes.filter(({ outcome }) => outcome === "error" || outcome === "cancelled");
  if (retried.length === 0) return undefined;
  const cancelled = retried.filter(({ outcome }) => outcome === "cancelled").length;
  const custom = run.model === "custom";
  const sandboxId = sandboxCredentialId ?? credentials.sandboxCredentialId;
  const managedSandbox = sandboxId === "managed-sandbox";
  const kind = saved.find((credential) => credential.id === sandboxId)?.kind;
  return {
    errored: retried.length - cancelled,
    cancelled,
    selection: {
      id,
      models: [
        {
          catalogId: run.model,
          // Custom models are recorded as `<provider>/<typed name>` (completedConfigurationTasks).
          ...(custom ? { customModel: run.modelName.replace(/^[^/]+\//, "") } : {}),
          credentialId: modelCredentialId ?? credentials.modelCredentialId,
          ...(run.thinking ? { thinking: run.thinking } : {}),
          harnesses: [harness],
          // A run that named its subagent model on its row, before conditions did, retries so.
          ...(run.subagent && !run.condition?.subagent
            ? {
                subagent: {
                  catalogId: run.subagent.catalogId,
                  credentialId: run.subagent.credentialId,
                },
              }
            : {}),
        },
      ],
      sandbox: managedSandbox ? "managed" : (kind ?? run.sandbox),
      sandboxCredentialId: sandboxId,
      tasks: retried.map(({ trial: { runId, taskId } }) => ({ runId, taskId })),
      ...(credentials.judgeCredentialId
        ? { judgeCredentialId: credentials.judgeCredentialId }
        : {}),
      skipCompleted: true,
      ...conditionFields(run),
    },
  };
}

/** The condition a run ran under, as a retry or a configuration's Run Missing runs it again. */
export function conditionFields(
  run: EvaluationRun,
): Pick<RetrySelection, "conditions" | "baseline"> {
  return run.condition
    ? {
        conditions: [
          {
            name: run.condition.name,
            ...(run.condition.harness ? { harness: run.condition.harness } : {}),
            skills: [...run.condition.skills],
            ...(run.condition.instructions ? { instructions: run.condition.instructions } : {}),
            ...(run.condition.environment ? { environment: run.condition.environment.id } : {}),
            ...(run.condition.harnessOptions
              ? { harnessOptions: run.condition.harnessOptions }
              : {}),
            ...(run.condition.subagent
              ? {
                  subagent: {
                    ...run.condition.subagent,
                    ...(run.subagent ? { credentialId: run.subagent.credentialId } : {}),
                  },
                }
              : {}),
          },
        ],
        baseline: false as const,
      }
    : {};
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

/**
 * The model credentials a retry may run on: the run's own first, then the org's other saved ones
 * that run its model on its harness (another key, gateway or Dari router). A custom model stays on
 * its own endpoint, and until the catalog loads only the run's own is offered.
 */
export function retryModelCredentials<
  Credential extends Pick<CredentialInfo, "id" | "kind" | "auth">,
>(
  run: EvaluationRun,
  harness: Harness,
  saved: readonly Credential[],
  catalog?: readonly CatalogModel[],
): Credential[] {
  const own = run.credentials?.modelCredentialId;
  const model =
    run.model === "custom" ? undefined : catalog?.find((entry) => entry.id === run.model);
  const runs = (credential: Credential) => {
    if (credential.id === own) return true;
    if (!model || isSandbox(credential.kind) || credential.kind === "custom") return false;
    const route = routeFor(model, credential.kind);
    return !!route?.harnesses.includes(harness) && credentialRunsHarness(credential.auth, harness);
  };
  const isOwn = (credential: Credential) => credential.id === own;
  const offered = saved.filter(runs);
  return [...offered.filter(isOwn), ...offered.filter((credential) => !isOwn(credential))];
}
