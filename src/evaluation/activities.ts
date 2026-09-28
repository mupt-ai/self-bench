import { Context } from "@temporalio/activity";
import type { ArtifactStore } from "../artifacts/index.js";
import type { Vault } from "../db/vault.js";
import { errorMessage } from "../lib/util.js";
import {
  executeEvaluation,
  failEvaluation,
  failTrial,
  finishEvaluation,
  startEvaluation,
} from "./lifecycle.js";
import { executeTrial, type RunnerOptions } from "./runner.js";
import { terminateTrialSandboxes } from "./sandbox-cleanup.js";
import type { EvaluationInput } from "./types.js";

export interface EvaluationActivities {
  /** Every trial in one activity: kept only for evaluations started before trials ran in parallel. */
  executeSolverEvaluation(input: EvaluationInput): Promise<void>;
  startSolverEvaluation(input: EvaluationInput): Promise<number>;
  runSolverTrial(input: EvaluationInput, index: number): Promise<void>;
  failSolverTrial(input: EvaluationInput, index: number): Promise<void>;
  finishSolverEvaluation(input: EvaluationInput): Promise<void>;
  failSolverEvaluation(input: EvaluationInput): Promise<void>;
}
export function createEvaluationActivities(
  store: ArtifactStore,
  vault?: Vault,
): EvaluationActivities {
  const heartbeating = async (run: (options: RunnerOptions) => Promise<void>) => {
    const context = Context.current();
    const timer = setInterval(() => context.heartbeat(), 10_000);
    try {
      await run({
        ...(vault ? { vault } : {}),
        signal: context.cancellationSignal,
        heartbeat: () => context.heartbeat(),
      });
    } finally {
      clearInterval(timer);
    }
  };
  // Best-effort and after the record: a trial the workflow gave up on may have died with its
  // worker, leaving Modal sandboxes that nothing else will stop before their lifetime cap.
  const terminateSandboxes = async (input: EvaluationInput, index?: number) => {
    if (!vault) return;
    try {
      const terminated = await terminateTrialSandboxes(input, index, process.env, vault);
      if (terminated > 0)
        console.log(`[selfbench] terminated ${terminated} Modal sandboxes of ${input.id}`);
    } catch (error) {
      console.warn(`[selfbench] Modal sandbox cleanup for ${input.id}: ${errorMessage(error)}`);
    }
  };
  return {
    executeSolverEvaluation: (input) =>
      heartbeating((options) => executeEvaluation(store, input, options)),
    startSolverEvaluation: (input) => startEvaluation(store, input),
    runSolverTrial: (input, index) =>
      heartbeating((options) => executeTrial(store, input, index, options)),
    failSolverTrial: async (input, index) => {
      await failTrial(store, input, index);
      await terminateSandboxes(input, index);
    },
    finishSolverEvaluation: (input) => finishEvaluation(store, input),
    failSolverEvaluation: async (input) => {
      await failEvaluation(
        store,
        input,
        "Worker interrupted or timed out. This evaluation will not retry automatically.",
      );
      await terminateSandboxes(input);
    },
  };
}
