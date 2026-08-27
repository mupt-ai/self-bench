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

export const MAX_CANDIDATES_PER_RUN = 10_000;

const candidateCountsSchema = z
  .object({
    easy: z.number().int().min(0).max(MAX_CANDIDATES_PER_RUN),
    medium: z.number().int().min(0).max(MAX_CANDIDATES_PER_RUN),
    hard: z.number().int().min(0).max(MAX_CANDIDATES_PER_RUN),
  })
  .refine(({ easy, medium, hard }) => easy + medium + hard >= 1, {
    message: "at least one candidate must be requested",
  })
  .refine(({ easy, medium, hard }) => easy + medium + hard <= MAX_CANDIDATES_PER_RUN, {
    message: `at most ${MAX_CANDIDATES_PER_RUN} candidates may be requested`,
  });

const runVersionSchema = z
  .object({
    selfbenchCommit: commitSchema,
    executionBackend: z.enum(EXECUTION_BACKENDS),
    harborEnvironment: z.enum(HARBOR_ENVIRONMENTS).optional(),
    sandboxImage: z.string().min(1),
    sandboxTimeoutCapMs: z.number().int().min(100).optional(),
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
    if (
      version.sandboxTimeoutCapMs !== undefined &&
      version.executionBackend !== "vercel" &&
      version.executionBackend !== "e2b"
    ) {
      context.addIssue({
        code: "custom",
        message: "sandboxTimeoutCapMs is only valid for Vercel or E2B execution",
        path: ["sandboxTimeoutCapMs"],
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

const environmentVariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const repositoryPathSchema = z
  .string()
  .min(1)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), {
    message: "expected a repository-relative path without parent traversal",
  });

const environmentVariablesSchema = z.record(environmentVariableNameSchema, z.string());

export const environmentServiceSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_-]*$/)
      .refine((name) => name !== "main", { message: 'service name "main" is reserved' }),
    image: z.string().min(1),
    environmentVariables: environmentVariablesSchema,
    command: z.array(z.string()).optional(),
    healthcheck: z
      .object({
        test: z.array(z.string().min(1)).min(1),
        intervalSeconds: z.number().int().positive(),
        timeoutSeconds: z.number().int().positive(),
        retries: z.number().int().positive(),
        startPeriodSeconds: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const taskEnvironmentSchema = z
  .object({
    schemaVersion: z.literal(1),
    baseImage: z.string().min(1),
    rootSetupCommand: z.string().min(1),
    setupCommand: z.string().min(1),
    smokeCommand: z.string().min(1),
    environmentVariables: environmentVariablesSchema,
    services: z.array(environmentServiceSchema),
    source: z.enum(["repository-dockerfile", "devcontainer", "ci-adapted", "generated"]),
    evidence: z
      .array(
        z
          .object({
            path: repositoryPathSchema,
            reason: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type TaskEnvironment = z.infer<typeof taskEnvironmentSchema>;

export const taskDraftDefinitionSchema = z
  .object({
    schemaVersion: z.literal(2),
    difficulty: difficultySchema,
    taskId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    repo: z.string().min(1),
    baseCommit: commitSchema,
    workdir: repositoryPathSchema.or(z.literal(".")),
    testCommand: z.string().refine((value) => value.includes("{tests}"), {
      message: 'testCommand must contain "{tests}"',
    }),
    failToPass: z.array(z.string().min(1)).min(1),
    passToPass: z.array(z.string().min(1)),
    testPaths: z.array(z.string().min(1)).min(1),
    sourcePr: z.number().int().positive(),
    sourceUrl: z.string().url(),
    prompt: z.string().min(1),
    timeouts: z
      .object({
        setupSeconds: z.number().int().positive(),
        agentSeconds: z.number().int().positive(),
        testsSeconds: z.number().int().positive(),
      })
      .strict(),
    resources: z
      .object({
        cpus: z.number().positive(),
        memoryMb: z.number().int().positive(),
        storageMb: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type TaskDraftDefinition = z.infer<typeof taskDraftDefinitionSchema>;

export const taskDefinitionSchema = taskDraftDefinitionSchema.extend({
  environment: taskEnvironmentSchema,
});

export type TaskDefinition = z.infer<typeof taskDefinitionSchema>;

export const authoredTaskDraftSchema = z.object({
  candidateId: z.string().min(1),
  taskId: z.string().min(1),
  definition: artifactRefSchema,
  sourceBundle: artifactRefSchema,
});

export type AuthoredTaskDraft = z.infer<typeof authoredTaskDraftSchema>;

export const authoredTaskSchema = z.object({
  candidateId: z.string().min(1),
  taskId: z.string().min(1),
  definition: artifactRefSchema,
  sourceBundle: artifactRefSchema,
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
