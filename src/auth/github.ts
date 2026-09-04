import type { AuthConfig } from "./config.js";

/** read:user for the profile, read:org for the allowlist, repo so discovery can read private PRs. */
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

/** Lowercased logins of every org the user belongs to, private memberships included (read:org). */
export async function fetchOrgLogins(
  config: Pick<AuthConfig, "githubApiUrl">,
  token: string,
  fetchImpl: FetchLike,
): Promise<string[]> {
  const logins: string[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetchImpl(`${config.githubApiUrl}/user/orgs?per_page=100&page=${page}`, {
      headers: apiHeaders(token),
    });
    if (!response.ok) throw new GitHubOAuthError(`GitHub /user/orgs failed (${response.status})`);
    const orgs = (await response.json()) as { login?: string }[];
    for (const org of orgs) {
      if (typeof org.login === "string") logins.push(org.login.toLowerCase());
    }
    if (orgs.length < 100) break;
  }
  return logins;
}

/** Empty allowlist admits everyone; otherwise one shared org (case-insensitive) is enough. */
export function orgAllowed(allowedOrgs: readonly string[], memberOf: readonly string[]): boolean {
  if (allowedOrgs.length === 0) return true;
  const allowed = new Set(allowedOrgs.map((org) => org.toLowerCase()));
  return memberOf.some((org) => allowed.has(org.toLowerCase()));
}

function apiHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "self-bench-site",
    "x-github-api-version": "2022-11-28",
  };
}
