import { EvaluationRequestError, evaluationRequest } from "./api";

export class UnsavedComparisonError extends Error {}

/** A failed response is ambiguous until the reserved ID has been checked. */
export async function submitComparison(url: string, draft: { id: string }) {
  try {
    return await evaluationRequest<{ id: string }>(`${url}/comparisons`, draft);
  } catch (failure) {
    try {
      return await evaluationRequest<{ id: string }>(`${url}/comparisons/${draft.id}`);
    } catch (lookup) {
      if (lookup instanceof EvaluationRequestError && lookup.status === 404)
        throw new UnsavedComparisonError(
          failure instanceof Error ? failure.message : "Comparison was not saved.",
        );
      throw failure;
    }
  }
}

/** Recover only the matching draft; keep its ID to retain server-side deduplication. */
export function unlockMissingComparison(url: string, id: string) {
  try {
    const key = `selfbench-run:${url}`;
    const saved = sessionStorage.getItem(key);
    if (!saved) return;
    // A repository's draft or a benchmark's: either keeps its request under `draft.id`.
    const state = JSON.parse(saved) as { draft?: { id?: unknown } } | null;
    if (state?.draft?.id === id)
      sessionStorage.setItem(key, JSON.stringify({ ...state, submitted: false }));
  } catch {}
}
