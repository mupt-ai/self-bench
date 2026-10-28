import { EvaluationRequestError, evaluationRequest } from "./api";

export class UnsavedComparisonError extends Error {}

/** A comparison's ID, and why some of its runs did not start (resume starts them under the same ID). */
export type ComparisonReceipt = {
  id: string;
  submissionError?: string;
};

export function resumeComparison(url: string, id: string) {
  return evaluationRequest<ComparisonReceipt>(`${url}/comparisons/${id}/resume`, {});
}

/** A failed response is ambiguous until the reserved ID has been checked. */
export async function submitComparison(url: string, draft: { id: string }) {
  try {
    return await evaluationRequest<ComparisonReceipt>(`${url}/comparisons`, draft);
  } catch (failure) {
    try {
      const status = await evaluationRequest<ComparisonReceipt & { runs?: { status: string }[] }>(
        `${url}/comparisons/${draft.id}`,
      );
      // The POST failed after saving. A run with no record was never started, so resume it.
      return status.runs?.some((run) => run.status === "pending")
        ? {
            ...status,
            submissionError:
              failure instanceof Error ? failure.message : "Some runs were not submitted.",
          }
        : status;
    } catch (lookup) {
      if (lookup instanceof EvaluationRequestError && lookup.status === 404)
        throw new UnsavedComparisonError(
          failure instanceof Error ? failure.message : "Comparison was not saved.",
        );
      throw failure;
    }
  }
}
