import { apiHeaders, GitHubOAuthError } from "../auth/github.js";
import type { Candidate, Difficulty } from "../contracts.js";
import { redactSecrets } from "../provenance/redact.js";
import type { ProvenanceMessage } from "../provenance/types.js";

const MAX_BODY_LENGTH = 12_000;

/** Everything the pipeline needs about a PR, before the provenance artifact exists. */
export interface PullRequestCandidate {
  readonly candidate: Omit<Candidate, "provenance">;
  readonly message: ProvenanceMessage;
  readonly title: string;
  readonly changedLines: number;
  readonly changedFiles: number;
}

export class PullRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 422,
  ) {
    super(message);
  }
}

/** Parses "123", "#123", or a github.com pull URL into a PR number for the given repository. */
export function parsePullRequestRef(text: string, fullName: string): number | undefined {
  const trimmed = text.trim();
  const bare = /^#?(\d+)$/.exec(trimmed);
  if (bare?.[1]) return Number(bare[1]);
  const url = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(trimmed);
  if (!url?.[3]) return undefined;
  if (`${url[1]}/${url[2]}`.toLowerCase() !== fullName.toLowerCase()) return undefined;
  return Number(url[3]);
}

/**
 * The same thresholds discovery applies: easy from 20 changed lines in one path, medium from 50
 * across two, hard from 100 across three. A PR gets the highest tier it clears.
 */
export function difficultyFor(changedLines: number, changedFiles: number): Difficulty | undefined {
  if (changedLines >= 100 && changedFiles >= 3) return "hard";
  if (changedLines >= 50 && changedFiles >= 2) return "medium";
  if (changedLines >= 20 && changedFiles >= 1) return "easy";
  return undefined;
}

/** Reads one merged PR with the user's token and shapes it as a pipeline candidate. */
export async function candidateFromPullRequest(
  config: { readonly githubApiUrl: string },
  token: string,
  fullName: string,
  number: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PullRequestCandidate> {
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetchImpl(`${config.githubApiUrl}${path}`, {
      headers: apiHeaders(token),
    });
    if (response.status === 404) throw new PullRequestError("pull request not found", 404);
    if (!response.ok) throw new GitHubOAuthError(`GitHub ${path} failed (${response.status})`);
    return (await response.json()) as Record<string, unknown>;
  };
  const pr = await get(`/repos/${fullName}/pulls/${number}`);
  if (pr.merged !== true || typeof pr.merge_commit_sha !== "string") {
    throw new PullRequestError("pull request is not merged", 422);
  }
  const user = pr.user as { login?: string; type?: string } | undefined;
  if (user?.type === "Bot") throw new PullRequestError("pull request was opened by a bot", 422);
  const changedLines = num(pr.additions) + num(pr.deletions);
  const changedFiles = num(pr.changed_files);
  const difficulty = difficultyFor(changedLines, changedFiles);
  if (!difficulty) {
    throw new PullRequestError(
      `pull request changes ${changedLines} lines across ${changedFiles} files; at least 20 lines are needed`,
      422,
    );
  }
  const completedCommit = pr.merge_commit_sha.toLowerCase();
  const merge = await get(`/repos/${fullName}/commits/${completedCommit}`);
  const parents = Array.isArray(merge.parents) ? (merge.parents as { sha?: string }[]) : [];
  const baseCommit = parents[0]?.sha?.toLowerCase();
  if (!baseCommit) throw new PullRequestError("merge commit has no parent", 422);
  const title = typeof pr.title === "string" ? pr.title.trim() : "";
  const body = typeof pr.body === "string" ? pr.body.trim() : "";
  if (!title) throw new PullRequestError("pull request has no title", 422);
  const sourceUrl =
    typeof pr.html_url === "string" ? pr.html_url : `https://github.com/${fullName}/pull/${number}`;
  const content = redactSecrets(
    body && body.length <= MAX_BODY_LENGTH ? `${title}\n\n${body}` : title,
  );
  const repository = fullName.toLowerCase();
  return {
    candidate: {
      candidateId: `${repository.split("/")[1] ?? "repo"}-pr-${number}`,
      difficulty,
      sourcePr: number,
      sourceUrl,
      baseCommit,
      completedCommit,
      request: content,
    },
    message: {
      sourceType: "github-pull-request",
      sessionId: `github:${repository}#${number}`,
      messageIndex: 0,
      content,
      sourcePr: number,
      sourceUrl,
    },
    title,
    changedLines,
    changedFiles,
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
