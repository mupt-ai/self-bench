import { type ActivityOptions, proxyActivities, workflowInfo } from "@temporalio/workflow";
import type { SelfBenchActivities } from "../activities.js";
import { harborTaskQueue } from "../task-queues.js";

const candidateOptions: ActivityOptions = {
  startToCloseTimeout: "7 hours",
  heartbeatTimeout: "10 minutes",
  cancellationType: "WAIT_CANCELLATION_COMPLETED",
  retry: {
    initialInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumInterval: "2 minutes",
    maximumAttempts: 4,
  },
};

const candidateActivities =
  proxyActivities<
    Pick<SelfBenchActivities, "runAuthoringRound" | "runReviewRound" | "buildExport">
  >(candidateOptions);

// The queue name depends on the running workflow, so the proxy is created per call.
const compileAndVerify: SelfBenchActivities["compileAndVerify"] = (input) =>
  proxyActivities<Pick<SelfBenchActivities, "compileAndVerify">>({
    ...candidateOptions,
    taskQueue: harborTaskQueue(workflowInfo().taskQueue),
  }).compileAndVerify(input);

const provenanceActivities = proxyActivities<
  Pick<
    SelfBenchActivities,
    "collectRunProvenance" | "collectExcludedSourcePrs" | "rebuildReplayCandidates"
  >
>({
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
  collectExcludedSourcePrs: provenanceActivities.collectExcludedSourcePrs,
  rebuildReplayCandidates: provenanceActivities.rebuildReplayCandidates,
  discoverCandidateShard: discoveryActivities.discoverCandidateShard,
  runAuthoringRound: candidateActivities.runAuthoringRound,
  compileAndVerify,
  runReviewRound: candidateActivities.runReviewRound,
  buildExport: candidateActivities.buildExport,
};
