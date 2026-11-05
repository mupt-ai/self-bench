import { commitSchema } from "../../contracts/index.js";
import { apiHeaders, GitHubOAuthError } from "./oauth.js";

/** A commit a person named that the repository does not have. */
export class CommitNotFoundError extends Error {
  readonly status = 422;
}

/** Resolves a SHA (full or short) or a branch of `fullName` to its full commit SHA. */
export async function resolveCommit(
  config: { readonly githubApiUrl: string },
  token: string,
  fullName: string,
  ref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(
    `${config.githubApiUrl}/repos/${fullName}/commits/${encodeURIComponent(ref)}`,
    { headers: apiHeaders(token), signal: AbortSignal.timeout(15_000) },
  );
  if (response.status === 404 || response.status === 422)
    throw new CommitNotFoundError(`${fullName} has no commit or branch named ${ref}`);
  if (!response.ok)
    throw new GitHubOAuthError(`Cannot resolve ${ref} (${response.status})`, response.status);
  return commitSchema.parse(((await response.json()) as { sha?: unknown }).sha).toLowerCase();
}
