import type { EvaluationRun } from "../../../../src/evaluation/types";

export type { EvaluationRun, EvaluationTrial, Harness } from "../../../../src/evaluation/types";
export interface EvaluationOptions {
  tasks: { runId: string; taskId: string; difficulty: string }[];
}
export function evaluationUrl(org: string, repo: string): string {
  return `/api/orgs/${encodeURIComponent(org)}/repos/${repo.split("/").map(encodeURIComponent).join("/")}/evaluations`;
}
export function evaluationRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export class EvaluationRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export async function evaluationRequest<Result>(url: string, selection?: object): Promise<Result> {
  const response = await fetch(
    url,
    selection
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(selection),
        }
      : undefined,
  );
  return (await succeeded(response)).json() as Promise<Result>;
}
/**
 * A repository's runs and the tag that names this list of them. Sending that tag back asks only
 * whether the list changed: undefined means it did not, and nothing was downloaded.
 */
export async function runsRequest(
  url: string,
  tag?: string,
): Promise<{ runs: EvaluationRun[]; tag?: string } | undefined> {
  const response = await fetch(url, tag ? { headers: { "if-none-match": tag } } : undefined);
  if (response.status === 304) return undefined;
  const { runs } = (await (await succeeded(response)).json()) as { runs: EvaluationRun[] };
  const next = response.headers.get("etag");
  return next ? { runs, tag: next } : { runs };
}
async function succeeded(response: Response): Promise<Response> {
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("Session expired. Please sign in again.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new EvaluationRequestError(
      body.error ??
        `Request failed (${response.status}). Retry with the same selection to avoid duplicate runs.`,
      response.status,
    );
  }
  return response;
}
