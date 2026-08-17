import { z } from "zod";
import { EXECUTION_BACKENDS, HARBOR_ENVIRONMENTS, matchingHarborEnvironment } from "./providers.js";

export const commitSchema = z.string().regex(/^[0-9a-f]{40}$/i, "expected a full commit SHA");

export const repositoryRefSchema = z.object({
  url: z.string().url(),
  commit: commitSchema,
});

export type RepositoryRef = z.infer<typeof repositoryRefSchema>;

export const artifactRefSchema = z.object({
  uri: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().min(1),
});

export type ArtifactRef = z.infer<typeof artifactRefSchema>;

export const difficultySchema = z.enum(["easy", "medium", "hard"]);
export type Difficulty = z.infer<typeof difficultySchema>;

const candidateCountsSchema = z
  .object({
    easy: z.number().int().min(0).max(100),
    medium: z.number().int().min(0).max(100),
    hard: z.number().int().min(0).max(100),
  })
  .refine(({ easy, medium, hard }) => easy + medium + hard >= 1, {
    message: "at least one candidate must be requested",
  })
  .refine(({ easy, medium, hard }) => easy + medium + hard <= 100, {
    message: "at most 100 candidates may be requested",
  });

const runVersionSchema = z
  .object({
    selfbenchCommit: commitSchema,
    executionBackend: z.enum(EXECUTION_BACKENDS),
    harborEnvironment: z.enum(HARBOR_ENVIRONMENTS).optional(),
    sandboxImage: z.string().min(1),
    schema: z.literal(1),
  })
  .transform((version, context) => {
    const harborEnvironment =
      version.harborEnvironment ?? matchingHarborEnvironment(version.executionBackend);
    if (!harborEnvironment) {
      context.addIssue({
        code: "custom",
        message: `harborEnvironment is required for ${version.executionBackend} execution`,
        path: ["harborEnvironment"],
      });
      return z.NEVER;
    }
    return { ...version, harborEnvironment };
  });

export const runRequestSchema = z.object({
  runId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
  repository: repositoryRefSchema,
  provenance: artifactRefSchema,
  candidateCounts: candidateCountsSchema,
  authoring: z.object({
    provider: z.literal("openai-codex"),
    model: z.string().min(1),
    reasoningEffort: z.literal("high"),
  }),
  version: runVersionSchema,
});

export type RunRequest = z.infer<typeof runRequestSchema>;

export const candidateSchema = z.object({
  candidateId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  difficulty: difficultySchema,
  sourcePr: z.number().int().positive(),
  sourceUrl: z.string().url(),
  baseCommit: commitSchema,
  completedCommit: commitSchema,
  request: z.string().min(1),
  provenance: artifactRefSchema,
});

export type Candidate = z.infer<typeof candidateSchema>;

export const taskDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  difficulty: difficultySchema,
  taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  repo: z.string().min(1),
  baseCommit: commitSchema,
  workdir: z.string().min(1),
  setupCommand: z.string().min(1),
  testCommand: z.string().refine((value) => value.includes("{tests}"), {
    message: 'testCommand must contain "{tests}"',
  }),
  failToPass: z.array(z.string().min(1)).min(1),
  passToPass: z.array(z.string().min(1)),
  testPaths: z.array(z.string().min(1)).min(1),
  toolchains: z.array(z.enum(["uv", "bun", "go", "node", "python", "rust"])).min(1),
  sourcePr: z.number().int().positive(),
  sourceUrl: z.string().url(),
  prompt: z.string().min(1),
  timeouts: z.object({
    setupSeconds: z.number().int().positive(),
    agentSeconds: z.number().int().positive(),
    testsSeconds: z.number().int().positive(),
  }),
  resources: z.object({
    cpus: z.number().positive(),
    memoryMb: z.number().int().positive(),
    storageMb: z.number().int().positive(),
  }),
});

export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;

export const authoredTaskSchema = z.object({
  candidateId: z.string().min(1),
  taskId: z.string().min(1),
  definition: artifactRefSchema,
  bundle: artifactRefSchema,
});

export type AuthoredTask = z.infer<typeof authoredTaskSchema>;

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
    | "authoring"
    | "auditing"
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

export type AuthorOutcome =
  | { readonly kind: "authored"; readonly task: AuthoredTask }
  | { readonly kind: "rejected"; readonly candidateId: string; readonly reason: string };

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
