import { z } from "zod";
import { redactSecrets } from "../../lib/redact.js";
import { isRecord } from "../../lib/util.js";
import { assertPullRequestBelongsToRepository, githubRepository } from "./repository.js";

const MAX_GITHUB_BODY_LENGTH = 12_000;

/**
 * The request a task is authored from: a merged PR's title and body. Runs recorded before local
 * agent sessions were dropped may still hold codex, claude-code, pi, or generic messages.
 */
const provenanceMessageBaseSchema = z.object({
  sessionId: z.string().min(1),
  messageIndex: z.number().int().nonnegative(),
  content: z.string().min(1),
});

const localProvenanceMessageSchema = provenanceMessageBaseSchema
  .extend({
    sourceType: z.enum(["codex", "claude-code", "pi", "generic"]),
    sourcePr: z.number().int().positive().optional(),
    sourceUrl: z.string().url().optional(),
  })
  .refine(
    (message) => (message.sourcePr === undefined) === (message.sourceUrl === undefined),
    "sourcePr and sourceUrl must be supplied together",
  );

export const provenanceMessageSchema = z.union([
  localProvenanceMessageSchema,
  provenanceMessageBaseSchema.extend({
    sourceType: z.literal("github-pull-request"),
    sourcePr: z.number().int().positive(),
    sourceUrl: z.string().url(),
  }),
]);

export type ProvenanceMessage = z.infer<typeof provenanceMessageSchema>;

/** Merged, human-authored PRs large enough to author from, as provenance messages. */
export function extractGitHubPullRequestProvenance(
  raw: string,
  repositoryUrl: string,
): ProvenanceMessage[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub pull request response must be an array");
  }
  const repository = githubRepository(repositoryUrl);
  const messages: ProvenanceMessage[] = [];
  for (const value of parsed) {
    if (!isRecord(value) || value.isDraft === true || !isHumanAuthor(value.author)) {
      continue;
    }
    const sourcePr = positiveIntegerValue(value.number);
    const sourceUrl = typeof value.url === "string" ? value.url : "";
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const body = typeof value.body === "string" ? value.body.trim() : "";
    const changedLines = nonnegativeNumber(value.additions) + nonnegativeNumber(value.deletions);
    const changedFiles = nonnegativeNumber(value.changedFiles);
    if (!sourcePr || !sourceUrl || !title || changedLines < 20 || changedFiles < 1) {
      continue;
    }
    assertPullRequestBelongsToRepository(repositoryUrl, sourceUrl, sourcePr);
    const content = redactSecrets(
      body && body.length <= MAX_GITHUB_BODY_LENGTH ? `${title}\n\n${body}` : title,
    );
    messages.push({
      sourceType: "github-pull-request",
      sessionId: `github:${repository}#${sourcePr}`,
      messageIndex: 0,
      content,
      sourcePr,
      sourceUrl,
    });
  }
  return messages;
}

function isHumanAuthor(value: unknown): boolean {
  if (!isRecord(value) || value.is_bot === true || typeof value.login !== "string") {
    return false;
  }
  return !value.login.toLowerCase().endsWith("[bot]");
}

/** A discovered candidate must point at provenance from its own pull request. */
export function assertProvenanceMatchesPullRequest(
  message: ProvenanceMessage,
  sourcePr: number,
  sourceUrl: string,
): void {
  if (message.sourcePr !== sourcePr || message.sourceUrl !== sourceUrl) {
    throw new Error(
      `pull request ${sourceUrl}#${sourcePr} does not match provenance ${message.sourceUrl}#${message.sourcePr}`,
    );
  }
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonnegativeNumber(value: unknown): number {
  return typeof value === "number" && value >= 0 ? value : 0;
}
