import type { BatchStatus } from "../../../src/site/batch-progress";

export type { BatchStatus };
export interface BatchRepoId {
  org: string;
  fullName: string;
}
export interface CandidateCounts {
  easy: number;
  medium: number;
  hard: number;
}
export interface BatchRun {
  runId: string;
  attachedAt: string;
  attachedBy: string;
}
const root = ({ org, fullName }: BatchRepoId) =>
  `/api/orgs/${encodeURIComponent(org)}/repos/${fullName.split("/").map(encodeURIComponent).join("/")}/batches`;
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "content-type": "application/json" } });
  const body = await response.json();
  if (!response.ok)
    throw new Error(`${body.error ?? response.status}${body.runId ? ` (${body.runId})` : ""}`);
  return body as T;
}
export const listBatches = (repo: BatchRepoId) => request<{ batches: BatchRun[] }>(root(repo));
export const startBatch = (repo: BatchRepoId, candidateCounts: CandidateCounts) =>
  request<{ runId: string }>(root(repo), {
    method: "POST",
    body: JSON.stringify({ candidateCounts }),
  });
export const fetchBatch = (repo: BatchRepoId, runId: string) =>
  request<BatchStatus>(`${root(repo)}/${runId}`);
export const cancelBatch = (repo: BatchRepoId, runId: string) =>
  request(`${root(repo)}/${runId}/cancel`, { method: "POST" });
export const batchIsTerminal = (phase: string) =>
  ["complete", "failed", "blocked", "cancelled"].includes(phase);
export function validCandidateCounts(counts: CandidateCounts): boolean {
  const values = Object.values(counts);
  const total = values.reduce((sum, n) => sum + n, 0);
  return values.every((n) => Number.isInteger(n) && n >= 0) && total > 0 && total <= 10000;
}
