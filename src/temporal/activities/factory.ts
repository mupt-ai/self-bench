import { createArtifactStore } from "../../artifacts.js";
import type { SelfBenchWorkerConfig } from "../../config.js";
import { createSandboxExecutor } from "../../sandbox/index.js";
import { authorCandidate } from "./authoring.js";
import { discoverCandidateShard } from "./discovery.js";
import { authorEnvironment, preflightEnvironment } from "./environment.js";
import { buildExport } from "./export.js";
import { collectRunProvenance } from "./provenance.js";
import { auditTask, repairTask, reviewTask } from "./review.js";
import type { SelfBenchActivities } from "./types.js";
import { repairValidationTask, validateTask } from "./validation.js";

export function createActivities(config: SelfBenchWorkerConfig): SelfBenchActivities {
  const store = createArtifactStore(config.artifact);
  const sandbox = createSandboxExecutor(config.execution);
  return {
    collectRunProvenance: (run) => collectRunProvenance(store, run),
    discoverCandidateShard: (input) => discoverCandidateShard(store, sandbox, input),
    authorCandidate: (input) => authorCandidate(store, sandbox, input),
    authorEnvironment: (input) => authorEnvironment(store, sandbox, input),
    preflightEnvironment: (input) => preflightEnvironment(store, config.harborEnvironment, input),
    validateTask: (input) => validateTask(store, config.harborEnvironment, input),
    repairValidationTask: (input) => repairValidationTask(store, sandbox, input),
    reviewTask: (input) => reviewTask(store, sandbox, input),
    repairTask: (input) => repairTask(store, sandbox, input),
    auditTask: (input) => auditTask(store, input),
    buildExport: (input) => buildExport(store, input),
  };
}
