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
  fullName: string;
  mergedPullRequests: number;
  since: string;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
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

export async function fetchRepos(org: string): Promise<Repo[]> {
  const body = await getJson<{ repos: Repo[] }>(`/api/repos?org=${encodeURIComponent(org)}`);
  return body.repos;
}

export function fetchRepoDetail(fullName: string): Promise<RepoDetail> {
  return getJson<RepoDetail>(`/api/repos/${fullName}`);
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
