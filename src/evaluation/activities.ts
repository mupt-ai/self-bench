import { Context, type Info } from "@temporalio/activity";
import type { ArtifactStore } from "../artifacts/index.js";
import { orgRecords } from "../db/encrypted-records.js";
import type { Vault } from "../db/vault.js";
import type { SandboxCallback } from "../generation/pipeline/sandbox-job.js";
import { withCredentialCapacity } from "../sandbox/capacity-wait.js";
import { credentialCapacity } from "../sandbox/credential-capacity.js";
import { failEvaluation, failTrial, finishEvaluation, startEvaluation } from "./lifecycle.js";
import { prepareTaskImages } from "./prepare.js";
import { executeTrial, type RunnerOptions } from "./runner.js";
import type { EvaluationInput } from "./types.js";

export interface EvaluationActivities {
  startSolverEvaluation(input: EvaluationInput): Promise<number>;
  /** Builds the one task in `input`'s images before its trials; returns what it built. */
  prepareTaskImages(input: EvaluationInput): Promise<string>;
  runSolverTrial(input: EvaluationInput, index: number): Promise<void>;
  failSolverTrial(input: EvaluationInput, index: number): Promise<void>;
  finishSolverEvaluation(input: EvaluationInput): Promise<void>;
  failSolverEvaluation(input: EvaluationInput): Promise<void>;
}
/** Whether Temporal runs another attempt if this one fails; an unknown policy counts as no. */
function retries({ attempt, retryPolicy }: Info): boolean {
  const maximum = retryPolicy?.maximumAttempts;
  return maximum !== undefined && (maximum === 0 || attempt < maximum);
}

export function createEvaluationActivities(
  store: ArtifactStore,
  vault?: Vault,
  snapshotLink?: SandboxCallback,
  stopping?: AbortSignal,
): EvaluationActivities {
  const heartbeating = async <T>(run: (options: RunnerOptions) => Promise<T>): Promise<T> => {
    const context = Context.current();
    const timer = setInterval(() => context.heartbeat(), 10_000);
    try {
      return await run({
        ...(vault ? { vault } : {}),
        ...(snapshotLink ? { snapshotLink } : {}),
        ...(stopping ? { stopping } : {}),
        signal: context.cancellationSignal,
        heartbeat: () => context.heartbeat(),
      });
    } finally {
      clearInterval(timer);
    }
  };
  const limited = async <T>(input: EvaluationInput, run: () => Promise<T>) => {
    const orgId = input.credentialOrgId ?? input.credentialOwnerId;
    const id = input.credentials?.sandboxCredentialId;
    const credential = vault && orgId && id ? await vault.credentials.find(orgId, id) : undefined;
    if (!vault || !orgId || !id || !credential?.maxSandboxes) return run();
    return withCredentialCapacity(
      credentialCapacity(orgRecords(vault.records, orgId), id, credential.maxSandboxes),
      72 * 60 * 60_000,
      run,
    );
  };
  return {
    startSolverEvaluation: (input) => startEvaluation(store, input),
    prepareTaskImages: (input) =>
      heartbeating((options) => limited(input, () => prepareTaskImages(store, input, options))),
    runSolverTrial: (input, index) =>
      heartbeating(async (options) => {
        const retry = retries(Context.current().info);
        const explain = await limited(input, () =>
          executeTrial(store, input, index, { ...options, retry }),
        );
        // Explaining a failed trial needs no sandbox, so it runs once the trial gives its slot back.
        await explain?.();
      }),
    failSolverTrial: (input, index) => failTrial(store, input, index),
    finishSolverEvaluation: (input) => finishEvaluation(store, input),
    failSolverEvaluation: (input) =>
      failEvaluation(
        store,
        input,
        "Worker interrupted or timed out. This evaluation will not retry automatically; sandbox cleanup may require operator verification.",
      ),
  };
}
