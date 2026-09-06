import type {
  EvaluationChoices,
  EvaluationRun,
  EvaluationSandbox,
  Harness,
} from "../../../../src/evaluation/types";

export type { EvaluationSetup } from "../../../../src/evaluation/profiles";
export type {
  EvaluationModel,
  EvaluationRun,
  EvaluationTrial,
  Harness,
} from "../../../../src/evaluation/types";
export interface EvaluationOptions extends EvaluationChoices {
  tasks: { runId: string; taskId: string; difficulty: string }[];
}
export interface EvaluationSelection {
  id: string;
  model: string;
  harnesses: Harness[];
  sandbox: EvaluationSandbox;
  tasks: { runId: string; taskId: string }[];
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
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("Session expired. Please sign in again.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      body.error ??
        `Request failed (${response.status}). Retry with the same selection to avoid duplicate runs.`,
    );
  }
  return response.json() as Promise<Result>;
}
export function startEvaluation(
  url: string,
  selection: EvaluationSelection,
): Promise<EvaluationRun> {
  return evaluationRequest(url, selection);
}
