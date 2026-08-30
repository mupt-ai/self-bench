import { assertPullRequestBelongsToRepository, githubRepository } from "../github.js";
import { runCommand } from "../process.js";
import { redactSecrets } from "./redact.js";
import { isRecord, nonnegativeNumber, positiveIntegerValue } from "./shared.js";
import type { ProvenanceMessage } from "./types.js";

const GITHUB_PULL_REQUEST_LIMIT = 500;
const MAX_GITHUB_BODY_LENGTH = 12_000;

export async function collectGitHubPullRequestProvenance(
  repositoryUrl: string,
  token?: string,
  signal?: AbortSignal,
): Promise<ProvenanceMessage[]> {
  const repository = githubRepository(repositoryUrl);
  const result = await runCommand(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "merged",
      "--limit",
      String(GITHUB_PULL_REQUEST_LIMIT),
      "--json",
      "number,title,body,url,author,isDraft,additions,deletions,changedFiles",
    ],
    {
      env: token ? { ...process.env, GH_TOKEN: token } : process.env,
      ...(signal ? { signal } : {}),
    },
  );
  return extractGitHubPullRequestProvenance(result.stdout, repositoryUrl);
}

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
