import { EvaluationRequestError, evaluationRequest } from "./api";

export class UnsavedComparisonError extends Error {}

/** A comparison's ID, its runs, and why some runs did not start. */
export type ComparisonReceipt = {
  id: string;
  submissionError?: string;
  runs?: { status: string }[];
};

/** A pending run was never submitted; resuming starts it under the same ID. */
export function hasUnconfirmedRuns(receipt: ComparisonReceipt) {
  return !!receipt.submissionError || !!receipt.runs?.some((run) => run.status === "pending");
}

export function resumeComparison(url: string, id: string) {
  return evaluationRequest<ComparisonReceipt>(`${url}/comparisons/${id}/resume`, {});
}

/** A failed response is ambiguous until the reserved ID has been checked. */
export async function submitComparison(url: string, draft: { id: string }) {
  try {
    return await evaluationRequest<ComparisonReceipt>(`${url}/comparisons`, draft);
  } catch (failure) {
    try {
      return await evaluationRequest<ComparisonReceipt>(`${url}/comparisons/${draft.id}`);
    } catch (lookup) {
      if (lookup instanceof EvaluationRequestError && lookup.status === 404)
        throw new UnsavedComparisonError(
          failure instanceof Error ? failure.message : "Comparison was not saved.",
        );
      throw failure;
    }
  }
}
