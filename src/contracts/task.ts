import { z } from "zod";
import { artifactRefSchema, commitSchema, difficultySchema } from "./common.js";

const candidateIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/**
 * A merged pull request to turn into a task: the repository at its base commit is the agent's
 * workspace. Candidates written before scenarios existed carry no `kind`.
 */
export const pullRequestCandidateSchema = z
  .object({
    kind: z.literal("pull_request").optional(),
    candidateId: candidateIdSchema,
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

export type PullRequestCandidate = z.infer<typeof pullRequestCandidateSchema>;

export const MAX_SCENARIO_TITLE_LENGTH = 120;
export const MAX_SCENARIO_LENGTH = 20_000;
export const MAX_ATTACHMENTS = 20;
/** Decoded; a request carries them base64-encoded, about a third larger. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * A person's description of a situation an agent should handle, with any files they attached.
 * No repository change stands behind it: the author writes the workspace itself (the files the
 * agent finds in /app), and the hidden tests grade what the agent leaves there.
 */
const scenarioCandidateSchema = z.object({
  kind: z.literal("scenario"),
  candidateId: candidateIdSchema,
  difficulty: difficultySchema,
  title: z.string().trim().min(1).max(MAX_SCENARIO_TITLE_LENGTH),
  request: z.string().min(1).max(MAX_SCENARIO_LENGTH),
  provenance: artifactRefSchema,
  /** The requester's files as one tarball, unpacked for the author at /work/attachments. */
  attachments: artifactRefSchema.optional(),
});

export type ScenarioCandidate = z.infer<typeof scenarioCandidateSchema>;

export type Candidate = PullRequestCandidate | ScenarioCandidate;

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
 * (built from `environment/`) and the separate verifier's (from `tests/`, which an older task
 * with services runs as Compose's `main`). Every trial starts from exactly these.
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
