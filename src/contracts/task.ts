import { z } from "zod";
import { artifactRefSchema, commitSchema, difficultySchema } from "./common.js";
import { featureDifficulty } from "./feature-tiers.js";

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
 * A person's description of a change or situation an agent should handle, with any files they
 * attached. No merged change stands behind it. With `baseCommit` (a repository scenario), the
 * agent starts from the repository at that commit and the author writes the reference
 * implementation and hidden tests against it, as for a PR. Without it (a workspace scenario), the
 * author writes the workspace itself (the files the agent finds in /app), and the hidden tests
 * grade what the agent leaves there.
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
  /** The repository commit a repository scenario starts from. */
  baseCommit: commitSchema.optional(),
});

export type ScenarioCandidate = z.infer<typeof scenarioCandidateSchema>;

/** The most merged pull requests one feature task is built from. */
const MAX_FEATURE_PULL_REQUESTS = 25;

const featurePullRequestSchema = z
  .object({
    number: z.number().int().positive(),
    url: z.string().url(),
    title: z.string().trim().min(1).max(500),
    /** The commit the PR landed as on the default branch (its merge or squash commit). */
    mergeCommit: commitSchema,
  })
  .superRefine((pr, context) => {
    if (!pullRequestNumberMatches(pr.url, pr.number)) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "url must be a canonical GitHub pull request URL matching number",
      });
    }
  });

/**
 * A feature: one capability the repository gained over several merged pull requests. The agent
 * starts from the commit before the first of them landed, and the hidden tests exercise the
 * finished feature end to end, as a user or caller meets it. The author builds the reference
 * implementation from the PRs' own changes, in merge order.
 */
export const featureCandidateSchema = z
  .object({
    kind: z.literal("feature"),
    candidateId: candidateIdSchema,
    difficulty: difficultySchema,
    title: z.string().trim().min(1).max(MAX_SCENARIO_TITLE_LENGTH),
    /** What the feature does, from its PRs' own descriptions (and the requester's, when asked). */
    request: z.string().min(1).max(MAX_SCENARIO_LENGTH),
    /** In merge order. */
    pullRequests: z.array(featurePullRequestSchema).min(1).max(MAX_FEATURE_PULL_REQUESTS),
    /** The default branch just before the first PR landed. */
    baseCommit: commitSchema,
    /** The default branch once the last PR landed. */
    completedCommit: commitSchema,
    provenance: artifactRefSchema,
  })
  .superRefine((candidate, context) => {
    const numbers = candidate.pullRequests.map((pr) => pr.number);
    if (new Set(numbers).size !== numbers.length) {
      context.addIssue({
        code: "custom",
        path: ["pullRequests"],
        message: "a feature lists each pull request once",
      });
    }
    if (candidate.difficulty !== featureDifficulty(numbers.length)) {
      context.addIssue({
        code: "custom",
        path: ["difficulty"],
        message: `a feature of ${numbers.length} pull requests is ${featureDifficulty(numbers.length)}`,
      });
    }
  });

export type FeatureCandidate = z.infer<typeof featureCandidateSchema>;

export type Candidate = PullRequestCandidate | ScenarioCandidate | FeatureCandidate;

/** The merged pull requests a candidate is built from: one PR's, a feature's several, a scenario's none. */
export function candidatePullRequests(candidate: Candidate): number[] {
  if (candidate.kind === "scenario") return [];
  if (candidate.kind === "feature") return candidate.pullRequests.map((pr) => pr.number);
  return [candidate.sourcePr];
}

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
