import { proxyActivities } from "@temporalio/workflow";
import type { SelfBenchActivities } from "../activities.js";

const candidateActivities = proxyActivities<
  Pick<
    SelfBenchActivities,
    "runAuthoringRound" | "compileAndVerify" | "runVerifierRound" | "buildExport"
  >
>({
  startToCloseTimeout: "7 hours",
  heartbeatTimeout: "10 minutes",
  cancellationType: "WAIT_CANCELLATION_COMPLETED",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "2 minutes",
    maximumAttempts: 4,
  },
});

const provenanceActivities = proxyActivities<Pick<SelfBenchActivities, "collectRunProvenance">>({
  startToCloseTimeout: "5 minutes",
  heartbeatTimeout: "3 minutes",
  cancellationType: "WAIT_CANCELLATION_COMPLETED",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 3,
  },
});

const discoveryActivities = proxyActivities<Pick<SelfBenchActivities, "discoverCandidateShard">>({
  startToCloseTimeout: "1 hour",
  heartbeatTimeout: "10 minutes",
  cancellationType: "WAIT_CANCELLATION_COMPLETED",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "1 minute",
    maximumAttempts: 3,
  },
});

export const workflowActivities: SelfBenchActivities = {
  collectRunProvenance: provenanceActivities.collectRunProvenance,
  discoverCandidateShard: discoveryActivities.discoverCandidateShard,
  runAuthoringRound: candidateActivities.runAuthoringRound,
  compileAndVerify: candidateActivities.compileAndVerify,
  runVerifierRound: candidateActivities.runVerifierRound,
  buildExport: candidateActivities.buildExport,
};
