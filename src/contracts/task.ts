import { z } from "zod";
import { assertPullRequestBelongsToRepository } from "../github.js";
import { artifactRefSchema, commitSchema, difficultySchema, isGitHubRepository } from "./common.js";

export const candidateSchema = z
  .object({
    candidateId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    difficulty: difficultySchema,
    sourcePr: z.number().int().positive(),
    sourceUrl: z.string().url(),
    baseCommit: commitSchema,
    completedCommit: commitSchema,
    request: z.string().min(1),
    provenance: artifactRefSchema,
  })
  .superRefine((candidate, context) => {
    if (!pullRequestNumberMatches(candidate.sourceUrl, candidate.sourcePr)) {
      context.addIssue({
        code: "custom",
        path: ["sourceUrl"],
        message: "sourceUrl must be a canonical GitHub pull request URL matching sourcePr",
      });
    }
  });

export type Candidate = z.infer<typeof candidateSchema>;

const environmentVariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const repositoryPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      !path.split("/").some((part) => !part || part === "." || part === ".."),
    { message: "expected a normalized repository-relative path" },
  );

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
    repo: z
      .string()
      .min(1)
      .refine((value) => isGitHubRepository(value), "expected a GitHub repository"),
    baseCommit: commitSchema,
    workdir: repositoryPathSchema.or(z.literal(".")),
    testCommand: z.string().refine((value) => value.split("{tests}").length === 2, {
      message: 'testCommand must contain "{tests}" exactly once',
    }),
    failToPass: z.array(z.string().min(1)).min(1),
    passToPass: z.array(z.string().min(1)),
    testPaths: z.array(repositoryPathSchema).min(1),
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
  .strict()
  .superRefine((definition, context) => {
    const testPaths = new Set(definition.testPaths);
    if (testPaths.size !== definition.testPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["testPaths"],
        message: "testPaths must be unique",
      });
    }
    const passToPass = new Set(definition.passToPass);
    const overlap = definition.failToPass.filter((test) => passToPass.has(test));
    if (overlap.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["passToPass"],
        message: "failToPass and passToPass must not overlap",
      });
    }
    try {
      assertPullRequestBelongsToRepository(
        definition.repo,
        definition.sourceUrl,
        definition.sourcePr,
      );
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["sourceUrl"],
        message: error instanceof Error ? error.message : "source pull request does not match repo",
      });
    }
  });

export type TaskDraftDefinition = z.infer<typeof taskDraftDefinitionSchema>;

export const taskDefinitionSchema = taskDraftDefinitionSchema.safeExtend({
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

function pullRequestNumberMatches(url: string, sourcePr: number): boolean {
  const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/i.exec(url);
  return match?.[1] !== undefined && Number(match[1]) === sourcePr;
}
