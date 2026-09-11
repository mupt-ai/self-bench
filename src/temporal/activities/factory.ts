import { createArtifactStore } from "../../artifacts.js";
import type { SelfBenchWorkerConfig } from "../../config.js";
import type { EncryptedRecordStore } from "../../evaluation/encrypted-records.js";
import { createSandboxExecutor } from "../../sandbox/index.js";
import { runAuthoringRound } from "./authoring-round.js";
import { discoverCandidateShard } from "./discovery.js";
import { collectExcludedSourcePrs } from "./excluded-source-prs.js";
import { buildExport } from "./export.js";
import { withGenerationRuntime } from "./generation-runtime.js";
import { collectRunProvenance } from "./provenance.js";
import { rebuildReplayCandidates } from "./replay.js";
import type { SelfBenchActivities } from "./types.js";
import { runVerifierRound } from "./verifier-round.js";
import { compileAndVerify } from "./verify.js";

export function createActivities(
  config: SelfBenchWorkerConfig,
  records?: EncryptedRecordStore,
): SelfBenchActivities {
  const store = createArtifactStore(config.artifact);
  const sandbox = createSandboxExecutor(config.execution);
  return {
    collectRunProvenance: (run) => collectRunProvenance(store, run),
    collectExcludedSourcePrs: (runIds) => collectExcludedSourcePrs(store, runIds),
    discoverCandidateShard: (input) =>
      withGenerationRuntime(
        config,
        records,
        input.run,
        "author",
        sandbox,
        (executor, _environment, run) => discoverCandidateShard(store, executor, { ...input, run }),
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
      ),
    compileAndVerify: (input) =>
      withGenerationRuntime(
        config,
        records,
        input.run,
        "author",
        sandbox,
        (_executor, environment, run) => compileAndVerify(store, environment, { ...input, run }),
      ),
    runVerifierRound: (input) =>
      withGenerationRuntime(
        config,
        records,
        input.run,
        "verifier",
        sandbox,
        (executor, environment, run) =>
          runVerifierRound(store, executor, environment, { ...input, run }),
      ),
    buildExport: (input) => buildExport(store, input),
  };
}
