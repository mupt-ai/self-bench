import { createArtifactStore } from "../artifacts/index.js";
import type { SelfBenchWorkerConfig } from "../config/index.js";
import type { EncryptedRecordStore } from "../evaluation/encrypted-records.js";
import type { UsageLedger } from "../managed/usage-store.js";
import { createSandboxExecutor } from "../sandbox/index.js";
import type { SelfBenchActivities } from "./activity-types.js";
import { runAuthoringRound } from "./authoring/round.js";
import { discoverCandidateShard } from "./discovery/activity.js";
import { runReviewRound } from "./review/round.js";
import { withGenerationRuntime } from "./runtime.js";
import { compileAndVerify } from "./verify/compile-and-verify.js";

export function createActivities(
  config: SelfBenchWorkerConfig,
  records?: EncryptedRecordStore,
  usage?: UsageLedger,
): SelfBenchActivities {
  const store = createArtifactStore(config.artifact);
  const sandbox = createSandboxExecutor(config.execution);
  return {
    discoverCandidateShard: (input) =>
      withGenerationRuntime(
        config,
        records,
        input.run,
        "author",
        sandbox,
        (executor, _environment, run) => discoverCandidateShard(store, executor, { ...input, run }),
        usage,
      ),
    runAuthoringRound: (input) =>
      withGenerationRuntime(
        config,
        records,
        input.run,
        "author",
        sandbox,
        (executor, environment, run) =>
          runAuthoringRound(store, executor, environment, { ...input, run }),
        usage,
      ),
    compileAndVerify: (input) =>
      withGenerationRuntime(
        config,
        records,
        input.run,
        "author",
        sandbox,
        (_executor, environment, run) => compileAndVerify(store, environment, { ...input, run }),
        usage,
      ),
    runReviewRound: (input) =>
      withGenerationRuntime(
        config,
        records,
        input.run,
        "verifier",
        sandbox,
        (executor, _environment, run) => runReviewRound(store, executor, { ...input, run }),
        usage,
      ),
  };
}
