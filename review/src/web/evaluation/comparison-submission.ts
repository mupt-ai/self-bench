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
