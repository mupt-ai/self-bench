import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../artifacts/index.js";
import type { Vault } from "../db/vault.js";
import type { SandboxCallback } from "../generation/pipeline/sandbox-job.js";
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
export function createEvaluationActivities(
  store: ArtifactStore,
  vault?: Vault,
  snapshotLink?: SandboxCallback,
): EvaluationActivities {
  const heartbeating = async <T>(run: (options: RunnerOptions) => Promise<T>): Promise<T> => {
    const context = Context.current();
    const timer = setInterval(() => context.heartbeat(), 10_000);
    try {
      return await run({
        ...(vault ? { vault } : {}),
        ...(snapshotLink ? { snapshotLink } : {}),
        signal: context.cancellationSignal,
        heartbeat: () => context.heartbeat(),
      });
    } finally {
      clearInterval(timer);
    }
  };
  return {
    startSolverEvaluation: (input) => startEvaluation(store, input),
    prepareTaskImages: (input) =>
      heartbeating((options) => prepareTaskImages(store, input, options)),
    runSolverTrial: (input, index) =>
      heartbeating((options) => executeTrial(store, input, index, options)),
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
