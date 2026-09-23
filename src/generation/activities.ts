import { createArtifactStore } from "../artifacts/index.js";
import type { SelfBenchWorkerConfig } from "../config/index.js";
import type { EncryptedRecordStore } from "../evaluation/encrypted-records.js";
import type { UsageLedger } from "../managed/usage-store.js";
import { createSandboxExecutor } from "../sandbox/index.js";
import type { SelfBenchActivities } from "./activity-types.js";
import { runAuthoringRound } from "./authoring/round.js";
import { discoverCandidateShard } from "./discovery/activity.js";
import { collectExcludedSourcePrs } from "./discovery/excluded-source-prs.js";
import { buildExport } from "./export.js";
import { collectRunProvenance } from "./provenance.js";
import { rebuildReplayCandidates } from "./replay.js";
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
    collectRunProvenance: (run) =>
      withGenerationRuntime(
        config,
        records,
        run,
        "author",
        sandbox,
        (_executor, _environment, configured) => collectRunProvenance(store, configured),
        usage,
      ),
    collectExcludedSourcePrs: (runIds) => collectExcludedSourcePrs(store, runIds),
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
    rebuildReplayCandidates: (input) => rebuildReplayCandidates(store, input),
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
    buildExport: (input) =>
      withGenerationRuntime(
        config,
        records,
        input.run,
        "author",
        sandbox,
        () => buildExport(store, input),
        usage,
      ),
  };
}
