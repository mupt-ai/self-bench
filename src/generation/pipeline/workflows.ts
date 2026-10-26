import { CancellationScope, isCancellation, proxyActivities } from "@temporalio/workflow";
import type {
  CandidateWorkflowInput,
  CandidateWorkflowResult,
  DiscoveryResult,
} from "../../contracts/index.js";
import { harbor, record, task } from "../../temporal/activity-options.js";
import { whenSandboxFree } from "../../temporal/sandbox-capacity.js";
import type { TaskActivities } from "../tasks/activities.js";
import type { DiscoveryShardInput, SelfBenchActivities, WorkerActivities } from "./activities.js";
import { executeCandidate, initialProgress, rootMessage } from "./candidate.js";

/** How long a candidate may take, waits for sandbox capacity included, before it gives up. */
const CANDIDATE_DEADLINE_MS = 14 * 24 * 60 * 60_000;

// Each sandbox step starts a sandbox and waits for its callback, then reads what it reported.
const agents = proxyActivities<Pick<WorkerActivities, "startAuthoringTurn" | "startReviewRound">>(
  task({ timeout: "5 hours", attempts: 4, heartbeat: "5 minutes" }),
);
const compile = proxyActivities<Pick<WorkerActivities, "compileTask">>(
  task({ timeout: "1 hour", attempts: 4, heartbeat: "5 minutes" }),
);
const discovery = proxyActivities<Pick<WorkerActivities, "startDiscoveryShard">>(
  task({ timeout: "1 hour", attempts: 3, heartbeat: "5 minutes" }),
);
const finish = proxyActivities<
  Pick<
    WorkerActivities,
    "finishDiscoveryShard" | "finishAuthoringTurn" | "finishReviewRound" | "finishCompile"
  >
>(task({ timeout: "15 minutes", attempts: 5 }));
// A progress write waits out a database outage. A verdict also publishes an accepted task's
// execution bundle, and keeps trying for a quarter of an hour before its fallback (settle).
const rows = proxyActivities<Pick<TaskActivities, "recordTaskProgress">>(
  record({ attempts: Number.POSITIVE_INFINITY }),
);
const verdicts = proxyActivities<Pick<TaskActivities, "settleTask">>(
  task({ timeout: "10 minutes", attempts: 10 }),
);
// Compaction streams each green attempt's full bundle once to check it before deleting it.
const compaction = proxyActivities<
  Pick<WorkerActivities, "compactCandidateBundles" | "discardCandidateImages">
>(task({ timeout: "2 hours", attempts: 3, heartbeat: "5 minutes" }));
const checks = () =>
  proxyActivities<Pick<WorkerActivities, "verifyCompiled">>(
    harbor({ timeout: "7 hours", attempts: 4, heartbeat: "10 minutes" }),
  );

/**
 * The workflow's steps. Each starts a sandbox that reports back through the callback API, then
 * reads what it reported; Harbor checks a compiled task on the memory-sized sibling queue.
 */
const workflowActivities: SelfBenchActivities = {
  discoverCandidateShard: async (input) =>
    await finish.finishDiscoveryShard({
      ...input,
      outcome: await whenSandboxFree(() => discovery.startDiscoveryShard(input)),
    }),
  runAuthoringTurn: async (input) =>
    await finish.finishAuthoringTurn({
      ...input,
      outcome: await whenSandboxFree(() => agents.startAuthoringTurn(input)),
    }),
  runReviewRound: async (input) =>
    await finish.finishReviewRound({
      ...input,
      outcome: await whenSandboxFree(() => agents.startReviewRound(input)),
    }),
  compileAndVerify: async (input) => {
    const compiled = await whenSandboxFree(() => compile.compileTask(input));
    const finished = await finish.finishCompile({ ...input, compiled });
    return await whenSandboxFree(() => checks().verifyCompiled({ ...input, compiled: finished }));
  },
};

/** One discovery shard of a batch; the batch workflow fetched its merged PRs. */
export async function selfBenchDiscoveryShardWorkflow(
  input: DiscoveryShardInput,
): Promise<DiscoveryResult> {
  return workflowActivities.discoverCandidateShard(input);
}

/**
 * Authors, verifies, and reviews one candidate, and owns its task row: each stage change is
 * recorded on it, and the workflow settles it however it ends, cancelled or out of time included.
 */
export async function selfBenchAuthorWorkflow(
  input: CandidateWorkflowInput,
): Promise<CandidateWorkflowResult> {
  const row = { runId: input.run.runId, candidateId: input.candidate.candidateId };
  let last = initialProgress(input.candidate);
  let result: CandidateWorkflowResult;
  try {
    result = await CancellationScope.withTimeout(CANDIDATE_DEADLINE_MS, () =>
      executeCandidate(input, workflowActivities, async (progress) => {
        last = progress;
        await rows.recordTaskProgress({ ...row, progress });
      }),
    );
  } catch (error) {
    if (!isCancellation(error)) throw error;
    const cancelled = CancellationScope.current().consideredCancelled;
    result = {
      progress: {
        ...last,
        status: "infrastructure_failed",
        reason: cancelled ? "Generation cancelled." : "Generation ran out of time (14 days).",
      },
    };
    await CancellationScope.nonCancellable(() =>
      settleStopped(input, result, cancelled, { ...verdicts, ...compaction }),
    );
    if (cancelled) throw error;
    return result;
  }
  // A finished verdict reaches the row even if a cancel lands meanwhile.
  const settled = await CancellationScope.nonCancellable(() => settle(row, result));
  await compact(input, settled, compaction);
  return settled;
}

/**
 * Settles the candidate's row with its verdict. An accepted task whose execution bundle cannot be
 * published settles as an infrastructure failure instead: its trials must run on its images.
 */
async function settle(
  row: { readonly runId: string; readonly candidateId: string },
  result: CandidateWorkflowResult,
): Promise<CandidateWorkflowResult> {
  try {
    await verdicts.settleTask({ ...row, result });
    return result;
  } catch (error) {
    if (isCancellation(error) || result.progress.status !== "accepted") throw error;
    const failed: CandidateWorkflowResult = {
      progress: {
        ...result.progress,
        status: "infrastructure_failed",
        reason: `The accepted task could not be published: ${rootMessage(error)}`,
      },
    };
    await verdicts.settleTask({ ...row, result: failed });
    return failed;
  }
}

type StoppedSteps = Pick<TaskActivities, "settleTask"> & CompactionSteps;
type CompactionSteps = Pick<WorkerActivities, "compactCandidateBundles" | "discardCandidateImages">;

/**
 * Settles a candidate a cancel or its deadline stopped: its row records where it stopped, and the
 * images and bundles it built are removed, cancelled or not.
 */
export async function settleStopped(
  input: CandidateWorkflowInput,
  result: CandidateWorkflowResult,
  cancelled: boolean,
  steps: StoppedSteps,
): Promise<void> {
  const row = { runId: input.run.runId, candidateId: input.candidate.candidateId };
  await steps.settleTask({ ...row, result, ...(cancelled ? { cancelled } : {}) });
  await compact(input, result, steps);
}

/**
 * Drops what the candidate stored but its task does not use: superseded compile attempts, and every
 * image it built except the accepted pair. Only storage is at stake, so neither ever fails it.
 */
async function compact(
  input: CandidateWorkflowInput,
  result: CandidateWorkflowResult,
  compaction: CompactionSteps,
) {
  const row = { runId: input.run.runId, candidateId: input.candidate.candidateId };
  const images = result.task?.images;
  const ignored = (error: unknown) => {
    if (isCancellation(error)) throw error;
  };
  await compaction
    .discardCandidateImages({ ...row, keep: images ? [images.agent, images.verifier] : [] })
    .catch(ignored);
  const kept = result.task ? artifactKey(result.task.bundle.uri) : undefined;
  // A task bundle outside the run's artifacts is never expected; compaction then keeps everything.
  if (result.task && !kept) return;
  await compaction.compactCandidateBundles({ ...row, kept: kept ? [kept] : [] }).catch(ignored);
}

/** The store key in an artifact URI (`gs://bucket/<prefix>/runs/...` or `file://.../runs/...`). */
function artifactKey(uri: string): string | undefined {
  const index = uri.indexOf("/runs/");
  return index < 0 ? undefined : uri.slice(index + 1);
}
