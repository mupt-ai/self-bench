import { createArtifactStore } from "../../artifacts.js";
import type { SelfBenchWorkerConfig } from "../../config.js";
import { createSandboxExecutor } from "../../sandbox/index.js";
import { runAuthoringRound } from "./authoring-round.js";
import { discoverCandidateShard } from "./discovery.js";
import { buildExport } from "./export.js";
import { collectRunProvenance } from "./provenance.js";
import type { SelfBenchActivities } from "./types.js";
import { runVerifierRound } from "./verifier-round.js";
import { compileAndVerify } from "./verify.js";

export function createActivities(config: SelfBenchWorkerConfig): SelfBenchActivities {
  const store = createArtifactStore(config.artifact);
  const sandbox = createSandboxExecutor(config.execution);
  return {
    collectRunProvenance: (run) => collectRunProvenance(store, run),
    discoverCandidateShard: (input) => discoverCandidateShard(store, sandbox, input),
    runAuthoringRound: (input) => runAuthoringRound(store, sandbox, input),
    compileAndVerify: (input) => compileAndVerify(store, config.harborEnvironment, input),
    runVerifierRound: (input) => runVerifierRound(store, sandbox, input),
    buildExport: (input) => buildExport(store, input),
  };
}
