import { z } from "zod";
import type { ArtifactRef, Difficulty } from "./common.js";
import { artifactRefSchema } from "./common.js";
import type { AuthoredTask, AuthoredTaskDraft, Candidate } from "./task.js";

export const validationResultSchema = z.object({
  taskId: z.string().min(1),
  accepted: z.boolean(),
  nop: z.object({
    passed: z.boolean(),
    result: artifactRefSchema,
    output: artifactRefSchema.optional(),
  }),
  oracle: z.object({
    passed: z.boolean(),
    result: artifactRefSchema,
    output: artifactRefSchema.optional(),
  }),
  reason: z.string().optional(),
});

export type ValidationResult = z.infer<typeof validationResultSchema>;

export type RunPhase =
  | "queued"
  | "discovering"
  | "authoring"
  | "exporting"
  | "complete"
  | "blocked"
  | "failed"
  | "cancelled";

export interface TaskProgress {
  taskId: string;
  candidateId: string;
  difficulty: Difficulty;
  status:
    | "task_authoring"
    | "environment_authoring"
    | "auditing"
    | "preflighting"
    | "environment_repairing"
    | "validating"
    | "reviewing"
    | "repairing"
    | "infrastructure_failed"
    | "rejected"
    | "accepted";
  reason?: string;
}

export interface DiscoveryProgress {
  readonly wave: number;
  readonly totalShards: number;
  readonly completedShards: number;
  readonly failedShards: number;
  readonly candidates: number;
}

export interface RunStatus {
  readonly runId: string;
  readonly phase: RunPhase;
  readonly requested: number;
  readonly requestedByDifficulty: Readonly<Record<Difficulty, number>>;
  readonly discovered: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly tasks: readonly TaskProgress[];
  readonly discovery?: DiscoveryProgress;
  readonly export?: ArtifactRef;
  readonly error?: string;
}

export interface RunResult {
  readonly runId: string;
  readonly export: ArtifactRef;
  readonly acceptedTaskIds: readonly string[];
}

export interface DiscoveryResult {
  readonly candidates: readonly Candidate[];
  readonly report: ArtifactRef;
}

export type TaskAuthorOutcome =
  | { readonly kind: "authored"; readonly task: AuthoredTaskDraft }
  | { readonly kind: "rejected"; readonly candidateId: string; readonly reason: string };

export type AuthorOutcome =
  | { readonly kind: "authored"; readonly task: AuthoredTask }
  | { readonly kind: "rejected"; readonly candidateId: string; readonly reason: string };

export interface EnvironmentPreflightResult {
  readonly taskId: string;
  readonly accepted: boolean;
  readonly report: ArtifactRef;
  readonly reason?: string;
}

export interface ReviewResult {
  readonly taskId: string;
  readonly accepted: boolean;
  readonly report: ArtifactRef;
  readonly reason?: string;
}

export interface AuditResult {
  readonly taskId: string;
  readonly accepted: boolean;
  readonly report: ArtifactRef;
  readonly reason?: string;
}
