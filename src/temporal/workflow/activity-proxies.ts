import { proxyActivities } from "@temporalio/workflow";
import type { SelfBenchActivities } from "../activities.js";

const taskActivities = proxyActivities<
  Omit<
    SelfBenchActivities,
    "collectRunProvenance" | "discoverCandidateShard" | "repairValidationTask"
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

const validationRepairActivity = proxyActivities<Pick<SelfBenchActivities, "repairValidationTask">>(
  {
    startToCloseTimeout: "2 hours",
    heartbeatTimeout: "10 minutes",
    cancellationType: "WAIT_CANCELLATION_COMPLETED",
    retry: { maximumAttempts: 1 },
  },
);

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
  authorCandidate: taskActivities.authorCandidate,
  authorEnvironment: taskActivities.authorEnvironment,
  preflightEnvironment: taskActivities.preflightEnvironment,
  validateTask: taskActivities.validateTask,
  repairValidationTask: validationRepairActivity.repairValidationTask,
  reviewTask: taskActivities.reviewTask,
  repairTask: taskActivities.repairTask,
  auditTask: taskActivities.auditTask,
  buildExport: taskActivities.buildExport,
};
