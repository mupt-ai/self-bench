import type { AuthConfig } from "./config.js";

/** read:user for the profile, read:org for org memberships, repo so discovery can read private PRs. */
export const OAUTH_SCOPES = ["read:user", "read:org", "repo"] as const;

export interface GitHubProfile {
  readonly githubId: number;
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

export class GitHubOAuthError extends Error {}

type FetchLike = typeof fetch;

export function callbackUrl(config: Pick<AuthConfig, "publicUrl">): string {
  return `${config.publicUrl}/auth/github/callback`;
}

export function authorizeUrl(
  config: Pick<AuthConfig, "githubUrl" | "clientId" | "publicUrl">,
  state: string,
): string {
  const url = new URL("/login/oauth/authorize", `${config.githubUrl}/`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(config));
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCode(
  config: AuthConfig,
  code: string,
  fetchImpl: FetchLike,
): Promise<{ token: string; scopes: string }> {
  const response = await fetchImpl(`${config.githubUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: callbackUrl(config),
    }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new GitHubOAuthError(
      `GitHub rejected the OAuth code: ${body.error_description ?? body.error ?? response.status}`,
    );
  }
  return { token: body.access_token, scopes: body.scope ?? "" };
}

export async function fetchProfile(
  config: Pick<AuthConfig, "githubApiUrl">,
  token: string,
  fetchImpl: FetchLike,
): Promise<GitHubProfile> {
  const response = await fetchImpl(`${config.githubApiUrl}/user`, { headers: apiHeaders(token) });
  if (!response.ok) throw new GitHubOAuthError(`GitHub /user failed (${response.status})`);
  const user = (await response.json()) as {
    id?: number;
    login?: string;
    name?: string | null;
    avatar_url?: string | null;
  };
  if (typeof user.id !== "number" || typeof user.login !== "string") {
    throw new GitHubOAuthError("GitHub /user returned no id or login");
  }
  return {
    githubId: user.id,
    login: user.login,
    ...(user.name ? { name: user.name } : {}),
    ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
  };
}

export interface OrgMembership {
  readonly githubId: number;
  readonly login: string;
  readonly avatarUrl?: string;
  readonly role: "admin" | "member";
}

/** Every org the user is an active member of, private memberships included (read:org). */
export async function fetchOrgMemberships(
  config: Pick<AuthConfig, "githubApiUrl">,
  token: string,
  fetchImpl: FetchLike,
): Promise<OrgMembership[]> {
  const memberships: OrgMembership[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetchImpl(
      `${config.githubApiUrl}/user/memberships/orgs?state=active&per_page=100&page=${page}`,
      { headers: apiHeaders(token) },
    );
    if (!response.ok) {
      throw new GitHubOAuthError(`GitHub /user/memberships/orgs failed (${response.status})`);
    }
    const rows = (await response.json()) as {
      role?: string;
      organization?: { id?: number; login?: string; avatar_url?: string | null };
    }[];
    for (const row of rows) {
      const org = row.organization;
      if (typeof org?.id !== "number" || typeof org.login !== "string") continue;
      memberships.push({
        githubId: org.id,
        login: org.login,
        ...(org.avatar_url ? { avatarUrl: org.avatar_url } : {}),
        role: row.role === "admin" ? "admin" : "member",
      });
    }
    if (rows.length < 100) break;
  }
  return memberships;
}

export function apiHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "self-bench-site",
    "x-github-api-version": "2022-11-28",
  };
}
