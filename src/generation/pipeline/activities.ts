import { createArtifactStore } from "../../artifacts/index.js";
import type { SelfBenchWorkerConfig } from "../../contracts/config/index.js";
import type {
  AuthoringTurnResult,
  DiscoveryResult,
  ReviewRoundResult,
  VerifyOutcome,
} from "../../contracts/index.js";
import type { UsageLedger } from "../../db/usage.js";
import type { Vault } from "../../db/vault.js";
import { createSandboxExecutor } from "../../sandbox/index.js";
import type { SandboxJobOutcome } from "../../sandbox/jobs.js";
import { type AuthoringTurnInput, runAuthoringTurn } from "./authoring.js";
import { type DiscoveryShardInput, discoverCandidateShard } from "./discovery.js";
import { type ReviewRoundInput, runReviewRound } from "./review.js";
import { withGenerationRuntime } from "./runtime.js";
import {
  type CompileAndVerifyInput,
  compileTask,
  type VerifyCompiledInput,
  verifyCompiled,
} from "./verify.js";

export type { DiscoveryShardInput };

/** The steps the candidate workflow takes; `compileAndVerify` is two activities in sequence. */
export interface SelfBenchActivities {
  discoverCandidateShard(input: DiscoveryShardInput): Promise<DiscoveryResult>;
  runAuthoringTurn(input: AuthoringTurnInput): Promise<AuthoringTurnResult>;
  compileAndVerify(input: CompileAndVerifyInput): Promise<VerifyOutcome>;
  runReviewRound(input: ReviewRoundInput): Promise<ReviewRoundResult>;
}

/** The activities the worker registers. */
export interface WorkerActivities extends Omit<SelfBenchActivities, "compileAndVerify"> {
  compileTask(input: CompileAndVerifyInput): Promise<SandboxJobOutcome>;
  verifyCompiled(input: VerifyCompiledInput): Promise<VerifyOutcome>;
}

/** Each activity resolves the run's sandbox, credentials, and metering, then does its stage. */
export function createActivities(
  config: SelfBenchWorkerConfig,
  vault?: Vault,
  usage?: UsageLedger,
): WorkerActivities {
  const store = createArtifactStore(config.artifact);
  const fallback = createSandboxExecutor(config.execution);
  const { secret, url } = config.sandboxCallback ?? {};
  if (!secret || !url) {
    throw new Error("SELFBENCH_SANDBOX_SECRET and SELFBENCH_SANDBOX_CALLBACK_URL are required");
  }
  const callback = { secret, url };
  const runtime = <T>(
    run: AuthoringTurnInput["run"],
    stage: "author" | "verifier",
    action: Parameters<typeof withGenerationRuntime<T>>[5],
  ) => withGenerationRuntime(config, vault, run, stage, fallback, action, usage);
  return {
    discoverCandidateShard: (input) =>
      runtime(input.run, "author", (sandbox, _harbor, run) =>
        discoverCandidateShard(store, sandbox, { ...input, run }),
      ),
    runAuthoringTurn: (input) =>
      runtime(input.run, "author", (sandbox, _harbor, run) =>
        runAuthoringTurn(store, sandbox, { ...input, run }),
      ),
    compileTask: (input) =>
      runtime(input.run, "author", (sandbox, _harbor, run) =>
        compileTask(store, sandbox, { ...input, run }, callback),
      ),
    verifyCompiled: (input) =>
      runtime(input.run, "author", (sandbox, harbor, run) =>
        verifyCompiled(store, sandbox, harbor, { ...input, run }),
      ),
    runReviewRound: (input) =>
      runtime(input.run, "verifier", (sandbox, _harbor, run) =>
        runReviewRound(store, sandbox, { ...input, run }),
      ),
  };
}
