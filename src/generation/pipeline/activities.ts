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
import {
  type AuthoringTurnInput,
  type FinishAuthoringTurnInput,
  finishAuthoringTurn,
  startAuthoringTurn,
} from "./authoring.js";
import {
  type DiscoveryShardInput,
  type FinishDiscoveryShardInput,
  finishDiscoveryShard,
  startDiscoveryShard,
} from "./discovery.js";
import {
  type FinishReviewRoundInput,
  finishReviewRound,
  type ReviewRoundInput,
  startReviewRound,
} from "./review.js";
import { withGenerationRuntime } from "./runtime.js";
import {
  type CompileAndVerifyInput,
  compileTask,
  finishCompile,
  type VerifyCompiledInput,
  verifyCompiled,
} from "./verify.js";

export type { DiscoveryShardInput };

/**
 * The steps the workflows take. Each is two activities in sequence: one starts a sandbox that
 * reports back through the callback API, the next reads what it reported.
 */
export interface SelfBenchActivities {
  discoverCandidateShard(input: DiscoveryShardInput): Promise<DiscoveryResult>;
  runAuthoringTurn(input: AuthoringTurnInput): Promise<AuthoringTurnResult>;
  compileAndVerify(input: CompileAndVerifyInput): Promise<VerifyOutcome>;
  runReviewRound(input: ReviewRoundInput): Promise<ReviewRoundResult>;
}

/** The activities the worker registers. */
export interface WorkerActivities {
  startDiscoveryShard(input: DiscoveryShardInput): Promise<SandboxJobOutcome>;
  finishDiscoveryShard(input: FinishDiscoveryShardInput): Promise<DiscoveryResult>;
  startAuthoringTurn(input: AuthoringTurnInput): Promise<SandboxJobOutcome>;
  finishAuthoringTurn(input: FinishAuthoringTurnInput): Promise<AuthoringTurnResult>;
  compileTask(input: CompileAndVerifyInput): Promise<SandboxJobOutcome>;
  finishCompile(input: VerifyCompiledInput): Promise<SandboxJobOutcome>;
  verifyCompiled(input: VerifyCompiledInput): Promise<VerifyOutcome>;
  startReviewRound(input: ReviewRoundInput): Promise<SandboxJobOutcome>;
  finishReviewRound(input: FinishReviewRoundInput): Promise<ReviewRoundResult>;
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
    startDiscoveryShard: (input) =>
      runtime(input.run, "author", (sandbox, _harbor, run) =>
        startDiscoveryShard(store, sandbox, callback, { ...input, run }),
      ),
    finishDiscoveryShard: (input) =>
      runtime(input.run, "author", (sandbox, _harbor, run) =>
        finishDiscoveryShard(store, sandbox, { ...input, run }),
      ),
    startAuthoringTurn: (input) =>
      runtime(input.run, "author", (sandbox, _harbor, run) =>
        startAuthoringTurn(store, sandbox, callback, { ...input, run }),
      ),
    finishAuthoringTurn: (input) =>
      runtime(input.run, "author", (sandbox, _harbor, run) =>
        finishAuthoringTurn(store, sandbox, { ...input, run }),
      ),
    compileTask: (input) =>
      runtime(input.run, "author", (sandbox, _harbor, run) =>
        compileTask(store, sandbox, { ...input, run }, callback),
      ),
    finishCompile: (input) =>
      runtime(input.run, "author", (sandbox) => finishCompile(sandbox, input)),
    verifyCompiled: (input) =>
      runtime(input.run, "author", (_sandbox, harbor, run) =>
        verifyCompiled(store, harbor, { ...input, run }),
      ),
    startReviewRound: (input) =>
      runtime(input.run, "verifier", (sandbox, _harbor, run) =>
        startReviewRound(store, sandbox, callback, { ...input, run }),
      ),
    finishReviewRound: (input) =>
      runtime(input.run, "verifier", (sandbox, _harbor, run) =>
        finishReviewRound(store, sandbox, { ...input, run }),
      ),
  };
}
