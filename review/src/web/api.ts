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

/** A pipeline run whose candidates count as the repo's tasks. */
export interface AttachedRun {
  runId: string;
  attachedBy: string;
  attachedAt: string;
}

export interface ArchivedRun {
  runId: string;
  status: string;
  startedAt?: string;
}

export type TaskState = "needs_review" | "accepted" | "rejected" | "in_progress";

export interface TaskReview {
  decision: "approve" | "reject";
  note: string;
  decidedBy: string;
  decidedAt: string;
}

export interface TaskItem {
  runId: string;
  taskId: string;
  candidateId: string;
  difficulty: string;
  stage: string;
  pipelineStatus: string;
  state: TaskState;
  reasonSummary?: string;
  sourcePr?: number;
  sourceUrl?: string;
  review?: TaskReview;
}

const repoPath = (org: string, fullName: string) =>
  `/api/orgs/${encodeURIComponent(org)}/repos/${fullName}`;

export async function fetchArchivedRuns(): Promise<ArchivedRun[]> {
  return (await requestJson<{ runs: ArchivedRun[] }>("/api/runs")).runs;
}

export async function fetchAttachedRuns(org: string, fullName: string): Promise<AttachedRun[]> {
  return (await requestJson<{ runs: AttachedRun[] }>(`${repoPath(org, fullName)}/runs`)).runs;
}

export async function attachRun(
  org: string,
  fullName: string,
  runId: string,
): Promise<AttachedRun> {
  const body = await requestJson<{ run: AttachedRun }>(`${repoPath(org, fullName)}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runId }),
  });
  return body.run;
}

export async function detachRun(org: string, fullName: string, runId: string): Promise<void> {
  await requestJson<{ ok: true }>(`${repoPath(org, fullName)}/runs/${runId}`, {
    method: "DELETE",
  });
}

export async function fetchTasks(org: string, fullName: string): Promise<TaskItem[]> {
  return (await requestJson<{ tasks: TaskItem[] }>(`${repoPath(org, fullName)}/tasks`)).tasks;
}

export async function putReview(
  org: string,
  fullName: string,
  runId: string,
  taskId: string,
  verdict: { decision: "approve" | "reject"; note: string },
): Promise<TaskReview> {
  const body = await requestJson<{ review: TaskReview }>(
    `${repoPath(org, fullName)}/tasks/${runId}/${encodeURIComponent(taskId)}/review`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(verdict),
    },
  );
  return body.review;
}

export async function clearReview(
  org: string,
  fullName: string,
  runId: string,
  taskId: string,
): Promise<void> {
  await requestJson<{ ok: true }>(
    `${repoPath(org, fullName)}/tasks/${runId}/${encodeURIComponent(taskId)}/review`,
    { method: "DELETE" },
  );
}

export function taskArtifactsPath(org: string, fullName: string, runId: string, taskId: string) {
  return `${repoPath(org, fullName)}/tasks/${runId}/${encodeURIComponent(taskId)}/artifacts`;
}
