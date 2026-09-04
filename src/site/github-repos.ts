import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../api/http.js";
import type { AuthConfig } from "../auth/config.js";
import { apiHeaders, GitHubOAuthError } from "../auth/github.js";
import type { User, UserStore } from "../auth/users.js";
import { tenantFor } from "./tenant.js";

/** One row in the picker; everything comes straight from GitHub's repository object. */
export interface RepoSummary {
  readonly githubId: number;
  readonly fullName: string;
  readonly name: string;
  readonly private: boolean;
  readonly archived: boolean;
  readonly defaultBranch: string;
  readonly language?: string;
  readonly description?: string;
  readonly pushedAt?: string;
}

/** What the picker shows once a repo is chosen: the honest eligibility signal. */
export interface RepoDetail {
  readonly fullName: string;
  readonly mergedPullRequests: number;
  readonly since: string;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const CACHE_TTL_MS = 5 * 60 * 1000;
const REPO_NAME = /^[A-Za-z0-9_.-]+$/;

export interface GitHubRepoRoutesOptions {
  readonly config: Pick<AuthConfig, "githubApiUrl">;
  readonly users: UserStore;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

export interface GitHubRepoRoutes {
  /** Answers the GitHub-backed repo listing and detail. True when the response has been sent. */
  handle(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    user: User,
  ): Promise<boolean>;
}

export function createGitHubRepoRoutes(options: GitHubRepoRoutesOptions): GitHubRepoRoutes {
  const { config, users } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const cache = new Map<string, { at: number; repos: RepoSummary[] }>();

  const listRepos = async (user: User, org: string): Promise<RepoSummary[] | undefined> => {
    const tenant = await tenantFor(users, user, org);
    if (!tenant) return undefined;
    const key = `${user.id}:${tenant.login}`;
    const cached = cache.get(key);
    if (cached && now().getTime() - cached.at < CACHE_TTL_MS) return cached.repos;
    const token = await users.gitHubToken(user.githubId);
    if (!token) throw new GitHubOAuthError("no GitHub token stored for this user");
    const path =
      tenant.kind === "user"
        ? "/user/repos?affiliation=owner,collaborator&sort=pushed"
        : `/orgs/${encodeURIComponent(tenant.login)}/repos?type=all&sort=pushed`;
    const repos = await fetchRepoPages(config, token, path, fetchImpl);
    cache.set(key, { at: now().getTime(), repos });
    return repos;
  };

  const repoDetail = async (user: User, fullName: string): Promise<RepoDetail> => {
    const token = await users.gitHubToken(user.githubId);
    if (!token) throw new GitHubOAuthError("no GitHub token stored for this user");
    const since = new Date(now().getTime() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const query = `repo:${fullName} is:pr is:merged merged:>=${since}`;
    const response = await fetchImpl(
      `${config.githubApiUrl}/search/issues?q=${encodeURIComponent(query)}&per_page=1`,
      { headers: apiHeaders(token) },
    );
    if (!response.ok) throw new GitHubOAuthError(`GitHub search failed (${response.status})`);
    const body = (await response.json()) as { total_count?: number };
    return { fullName, mergedPullRequests: body.total_count ?? 0, since };
  };

  return {
    async handle(request, url, response, user) {
      if (request.method !== "GET") return false;
      const listing = /^\/api\/orgs\/([^/]+)\/github-repos$/.exec(url.pathname);
      if (listing?.[1]) {
        const repos = await listRepos(user, listing[1]);
        if (!repos) {
          sendJson(response, 404, { error: "unknown organization" });
          return true;
        }
        sendJson(response, 200, { repos });
        return true;
      }
      const detail = /^\/api\/github-repos\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (detail?.[1] && detail[2]) {
        if (!REPO_NAME.test(detail[1]) || !REPO_NAME.test(detail[2])) {
          sendJson(response, 400, { error: "invalid repository name" });
          return true;
        }
        sendJson(response, 200, await repoDetail(user, `${detail[1]}/${detail[2]}`));
        return true;
      }
      return false;
    },
  };
}

/** One repository as the user's token sees it; undefined when GitHub answers 404. */
export async function lookupRepo(
  config: Pick<AuthConfig, "githubApiUrl">,
  token: string,
  fullName: string,
  fetchImpl: typeof fetch,
): Promise<RepoSummary | undefined> {
  const response = await fetchImpl(`${config.githubApiUrl}/repos/${fullName}`, {
    headers: apiHeaders(token),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new GitHubOAuthError(`GitHub repo lookup failed (${response.status})`);
  return summaryFrom((await response.json()) as RepoRow);
}

interface RepoRow {
  id?: number;
  full_name?: string;
  name?: string;
  private?: boolean;
  archived?: boolean;
  default_branch?: string;
  language?: string | null;
  description?: string | null;
  pushed_at?: string | null;
}

function summaryFrom(row: RepoRow): RepoSummary | undefined {
  if (typeof row.id !== "number" || !row.full_name || !row.name) return undefined;
  return {
    githubId: row.id,
    fullName: row.full_name,
    name: row.name,
    private: row.private === true,
    archived: row.archived === true,
    defaultBranch: row.default_branch ?? "main",
    ...(row.language ? { language: row.language } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.pushed_at ? { pushedAt: row.pushed_at } : {}),
  };
}

async function fetchRepoPages(
  config: Pick<AuthConfig, "githubApiUrl">,
  token: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<RepoSummary[]> {
  const repos: RepoSummary[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetchImpl(
      `${config.githubApiUrl}${path}&per_page=${PAGE_SIZE}&page=${page}`,
      { headers: apiHeaders(token) },
    );
    if (!response.ok) throw new GitHubOAuthError(`GitHub repos failed (${response.status})`);
    const rows = (await response.json()) as RepoRow[];
    for (const row of rows) {
      const summary = summaryFrom(row);
      if (summary) repos.push(summary);
    }
    if (rows.length < PAGE_SIZE) break;
  }
  return repos;
}
