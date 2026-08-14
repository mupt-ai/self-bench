import type { Evaluation, EvaluationSummary } from "./types";

export async function listEvaluations(signal?: AbortSignal) {
  return request<EvaluationSummary[]>("/api/evaluations", { signal });
}

export async function getEvaluation(id: string, signal?: AbortSignal) {
  return request<Evaluation>(`/api/evaluations/${encodeURIComponent(id)}`, { signal });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // Keep the HTTP fallback for non-JSON failures.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
