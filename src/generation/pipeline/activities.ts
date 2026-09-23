import { createArtifactStore } from "../../artifacts/index.js";
import type { SelfBenchWorkerConfig } from "../../contracts/config/index.js";
import type {
  AuthoringRoundResult,
  DiscoveryResult,
  ReviewRoundResult,
  VerifyOutcome,
} from "../../contracts/index.js";
import type { UsageLedger } from "../../db/usage.js";
import type { Vault } from "../../db/vault.js";
import { createSandboxExecutor } from "../../sandbox/index.js";
import { type AuthoringRoundInput, runAuthoringRound } from "./authoring.js";
import { type DiscoveryShardInput, discoverCandidateShard } from "./discovery.js";
import { type ReviewRoundInput, runReviewRound } from "./review.js";
import { withGenerationRuntime } from "./runtime.js";
import { type CompileAndVerifyInput, compileAndVerify } from "./verify.js";

export type { DiscoveryShardInput };

export interface SelfBenchActivities {
  discoverCandidateShard(input: DiscoveryShardInput): Promise<DiscoveryResult>;
  runAuthoringRound(input: AuthoringRoundInput): Promise<AuthoringRoundResult>;
  compileAndVerify(input: CompileAndVerifyInput): Promise<VerifyOutcome>;
  runReviewRound(input: ReviewRoundInput): Promise<ReviewRoundResult>;
}

/** Each activity resolves the run's sandbox, credentials, and metering, then does its stage. */
export function createActivities(
  config: SelfBenchWorkerConfig,
  vault?: Vault,
  usage?: UsageLedger,
): SelfBenchActivities {
  const store = createArtifactStore(config.artifact);
  const fallback = createSandboxExecutor(config.execution);
  const runtime = <T>(
    run: AuthoringRoundInput["run"],
    stage: "author" | "verifier",
    action: Parameters<typeof withGenerationRuntime<T>>[5],
  ) => withGenerationRuntime(config, vault, run, stage, fallback, action, usage);
  return {
    discoverCandidateShard: (input) =>
      runtime(input.run, "author", (sandbox, _harbor, run) =>
        discoverCandidateShard(store, sandbox, { ...input, run }),
      ),
    runAuthoringRound: (input) =>
      runtime(input.run, "author", (sandbox, harbor, run) =>
        runAuthoringRound(store, sandbox, harbor, { ...input, run }),
      ),
    compileAndVerify: (input) =>
      runtime(input.run, "author", (sandbox, harbor, run) =>
        compileAndVerify(store, sandbox, harbor, { ...input, run }),
      ),
    runReviewRound: (input) =>
      runtime(input.run, "verifier", (sandbox, _harbor, run) =>
        runReviewRound(store, sandbox, { ...input, run }),
      ),
  };
}
