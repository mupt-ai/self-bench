import { z } from "zod";
import { artifactRefSchema, commitSchema, difficultySchema } from "./common.js";

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

/** What an author hands off: its submission (generation/task/submission.ts) as a tarball. */
export const authoredTaskDraftSchema = z.object({
  candidateId: z.string().min(1),
  taskId: z.string().min(1),
  sourceBundle: artifactRefSchema,
});

export type AuthoredTaskDraft = z.infer<typeof authoredTaskDraftSchema>;

const registryImageSchema = z
  .string()
  .regex(/^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/);

/**
 * The images a task's checks ran on, by digest in SelfBench's task image repository: the agent's
 * (built from `environment/`) and the separate verifier's (from `tests/`, which a task with
 * services runs as Compose's `main`). Every trial starts from exactly these.
 */
export const taskImagesSchema = z.object({
  agent: registryImageSchema,
  verifier: registryImageSchema,
});

export type TaskImages = z.infer<typeof taskImagesSchema>;

export const authoredTaskSchema = z.object({
  candidateId: z.string().min(1),
  taskId: z.string().min(1),
  sourceBundle: artifactRefSchema,
  bundle: artifactRefSchema,
  images: taskImagesSchema.optional(),
});

export type AuthoredTask = z.infer<typeof authoredTaskSchema>;

function pullRequestNumberMatches(url: string, sourcePr: number): boolean {
  const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/i.exec(url);
  return match?.[1] !== undefined && Number(match[1]) === sourcePr;
}
