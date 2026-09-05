import type { AuthConfig } from "../auth/config.js";
import { apiHeaders, GitHubOAuthError } from "../auth/github.js";

const PAGE_SIZE = 20;
// GitHub search exposes at most 1,000 results.
export const MAX_PR_PAGE = Math.ceil(1000 / PAGE_SIZE);

export async function listMergedPullRequests(
  config: Pick<AuthConfig, "githubApiUrl">,
  token: string,
  fullName: string,
  page: number,
  fetchImpl: typeof fetch,
) {
  const query = `repo:${fullName} is:pr is:merged`;
  const response = await fetchImpl(
    `${config.githubApiUrl}/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${PAGE_SIZE}&page=${page}`,
    { headers: apiHeaders(token) },
  );
  if (!response.ok)
    throw new GitHubOAuthError(`GitHub pull request listing failed (${response.status})`);
  const body = (await response.json()) as {
    total_count: number;
    incomplete_results?: boolean;
    items: {
      number: number;
      title: string;
      user?: { login?: string; type?: string };
      pull_request?: { merged_at?: string | null };
    }[];
  };
  return {
    pullRequests: body.items
      .filter((row) => row.pull_request?.merged_at && row.user?.type !== "Bot")
      .map((row) => ({
        number: row.number,
        title: row.title,
        author: row.user?.login ?? "",
        mergedAt: row.pull_request?.merged_at,
      })),
    nextPage: page * PAGE_SIZE < Math.min(body.total_count, 1000) ? page + 1 : null,
    incomplete: body.incomplete_results === true,
  };
}
