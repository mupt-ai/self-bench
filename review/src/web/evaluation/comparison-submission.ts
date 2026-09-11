import { EvaluationRequestError, evaluationRequest } from "./api";
import { restoreRunDraft } from "./run-draft";

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
    const state = restoreRunDraft(saved, null);
    if (state.draft.id === id)
      sessionStorage.setItem(key, JSON.stringify({ ...state, submitted: false }));
  } catch {}
}
