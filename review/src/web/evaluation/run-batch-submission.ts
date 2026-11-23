import { EvaluationRequestError, evaluationRequest } from "./api";

export class UnsavedRunBatchError extends Error {}

/** A batch's ID, and why some of its runs did not start (resume starts them under the same ID). */
export type RunBatchReceipt = {
  id: string;
  submissionError?: string;
  /** Tasks close to the sandbox credential's resource limits, or that its provider rounds. */
  resourceWarnings?: string[];
};

export function resumeRunBatch(url: string, id: string) {
  return evaluationRequest<RunBatchReceipt>(`${url}/batches/${id}/resume`, {});
}

/** A failed response is ambiguous until the reserved ID has been checked. */
export async function submitRunBatch(url: string, draft: { id: string }) {
  try {
    return await evaluationRequest<RunBatchReceipt>(`${url}/batches`, draft);
  } catch (failure) {
    try {
      const status = await evaluationRequest<RunBatchReceipt & { runs?: { status: string }[] }>(
        `${url}/batches/${draft.id}`,
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
        throw new UnsavedRunBatchError(
          failure instanceof Error ? failure.message : "Batch was not saved.",
        );
      throw failure;
    }
  }
}
