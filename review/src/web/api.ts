export interface Repo {
  githubId: number;
  fullName: string;
  name: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  language?: string;
  description?: string;
  pushedAt?: string;
}

export interface RepoDetail {
  repo: Repo;
  mergedPullRequests: number;
  since: string;
}

/** A repository connected to the org; tasks accumulate under it. */
export interface ConnectedRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  continuous: boolean;
  connectedBy: string;
  connectedAt: string;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });
  if (!response.ok) {
    let detail = String(response.status);
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // keep the status code
    }
    throw new Error(detail);
  }
  return response.json() as Promise<T>;
}

export async function fetchGitHubRepos(org: string): Promise<Repo[]> {
  const body = await requestJson<{ repos: Repo[] }>(
    `/api/orgs/${encodeURIComponent(org)}/github-repos`,
  );
  return body.repos;
}

export function fetchGitHubRepoDetail(fullName: string): Promise<RepoDetail> {
  return requestJson<RepoDetail>(`/api/github-repos/${fullName}`);
}

export async function fetchConnectedRepos(org: string): Promise<ConnectedRepo[]> {
  const body = await requestJson<{ repos: ConnectedRepo[] }>(
    `/api/orgs/${encodeURIComponent(org)}/repos`,
  );
  return body.repos;
}

export async function connectRepo(org: string, fullName: string): Promise<ConnectedRepo> {
  const body = await requestJson<{ repo: ConnectedRepo }>(
    `/api/orgs/${encodeURIComponent(org)}/repos`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fullName }),
    },
  );
  return body.repo;
}

export async function setRepoContinuous(
  org: string,
  fullName: string,
  continuous: boolean,
): Promise<ConnectedRepo> {
  const body = await requestJson<{ repo: ConnectedRepo }>(
    `/api/orgs/${encodeURIComponent(org)}/repos/${fullName}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ continuous }),
    },
  );
  return body.repo;
}

export async function disconnectRepo(org: string, fullName: string): Promise<void> {
  await requestJson<{ ok: true }>(`/api/orgs/${encodeURIComponent(org)}/repos/${fullName}`, {
    method: "DELETE",
  });
}

/** "3d ago" style, for last-push columns; falls back to the date when older than a month. */
export function formatAgo(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days}d ago`;
  return iso.slice(0, 10);
}
