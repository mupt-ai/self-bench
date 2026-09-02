import type {
  ArtifactRef,
  AuthoredTask,
  Candidate,
  RunRequest,
  TaskProgress,
} from "../../contracts.js";
import type { SelfBenchActivities } from "../activities.js";

/** Consecutive rounds whose verify hit Harbor infrastructure before the candidate stops counting rounds. */
export const MAX_CONSECUTIVE_INFRASTRUCTURE_ROUNDS = 3;

export interface StageContext {
  readonly activitySet: SelfBenchActivities;
  readonly run: RunRequest;
  /** taskId → owning candidateId, so two candidates never export the same task. */
  readonly taskIds: Map<string, string>;
  readonly update: (patch: Partial<TaskProgress>) => void;
}

export type StageOutcome =
  | { readonly kind: "green"; readonly task: AuthoredTask; readonly report: ArtifactRef }
  | { readonly kind: "rejected"; readonly reason: string }
  | { readonly kind: "infrastructure_failed"; readonly reason: string };

export function rejected(reason: string): StageOutcome {
  return { kind: "rejected", reason };
}

/** Tracks consecutive infrastructure-flagged rounds. */
export function infrastructureCounter(): {
  observe(infrastructure: boolean): boolean;
} {
  let consecutive = 0;
  return {
    observe(infrastructure: boolean): boolean {
      consecutive = infrastructure ? consecutive + 1 : 0;
      return consecutive >= MAX_CONSECUTIVE_INFRASTRUCTURE_ROUNDS;
    },
  };
}

export function claimTaskId(
  context: StageContext,
  candidate: Candidate,
  taskId: string,
): string | undefined {
  const owner = context.taskIds.get(taskId);
  if (owner !== undefined && owner !== candidate.candidateId) {
    return `authoring repeated task ID ${taskId} already claimed by ${owner}`;
  }
  context.taskIds.set(taskId, candidate.candidateId);
  return undefined;
}
