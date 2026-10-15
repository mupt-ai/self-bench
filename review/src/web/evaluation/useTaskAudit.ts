import { useCallback, useEffect, useState } from "react";
import type { TaskAudit, TaskAuditFailure } from "../../../../src/evaluation/task-audit";
import { evaluationRequest } from "./api";
import type { ExplanationSelection } from "./useFailureExplanation";

/** What the server says of one task's audit (src/api/routes/audit-task.ts). */
interface AuditState {
  available: boolean;
  running: boolean;
  attempts: number;
  failures: number;
  reason?: string;
  audit?: TaskAudit;
  /** Why the latest audit gave no answer, when it is newer than `audit`. */
  failure?: TaskAuditFailure;
}

const POLL_MS = 4000;

/**
 * Audit Task for one task: whether the server offers it, its last audit, asking for another, and
 * waiting while it runs, polling only the audit's state.
 */
export function useTaskAudit({
  baseUrl,
  runId,
  taskId,
  enabled,
}: {
  baseUrl: string;
  runId: string;
  taskId: string;
  /** Whether a signed-in user has the task open. */
  enabled: boolean;
}) {
  const [state, setState] = useState<AuditState>();
  const [error, setError] = useState("");
  const stateUrl = `${baseUrl}/audit?${new URLSearchParams({ runId, taskId })}`;
  const auditing = !!state?.running;

  const check = useCallback(
    async () => setState(await evaluationRequest<AuditState>(stateUrl)),
    [stateUrl],
  );
  useEffect(() => {
    setState(undefined);
    setError("");
    if (!enabled) return;
    let disposed = false;
    evaluationRequest<AuditState>(stateUrl).then(
      (answer) => {
        if (!disposed) setState(answer);
      },
      (cause) => {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : "Could not load the audit");
      },
    );
    return () => {
      disposed = true;
    };
  }, [enabled, stateUrl]);

  useEffect(() => {
    if (!auditing) return;
    const previous = [state?.audit?.auditedAt, state?.failure?.failedAt];
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const answer = await evaluationRequest<AuditState>(stateUrl);
        if (disposed) return;
        if (answer.running) {
          timer = setTimeout(() => void poll(), POLL_MS);
          return;
        }
        setState(answer);
        if (answer.audit?.auditedAt === previous[0] && answer.failure?.failedAt === previous[1])
          setError("No audit came back. Try again in a few minutes.");
      } catch (cause) {
        if (disposed) return;
        setState((current) => current && { ...current, running: false });
        setError(cause instanceof Error ? cause.message : "Could not check the audit");
      }
    };
    timer = setTimeout(() => void poll(), POLL_MS);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [auditing, stateUrl, state?.audit?.auditedAt, state?.failure?.failedAt]);

  const audit = async (selection: ExplanationSelection) => {
    if (auditing || !state?.available) return;
    setError("");
    try {
      await evaluationRequest(`${baseUrl}/audit`, { runId, taskId, audit: selection });
      setState((current) => current && { ...current, running: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the audit");
      await check().catch(() => undefined);
    }
  };

  return {
    state,
    auditing,
    error:
      error ||
      (state?.failure && !auditing ? `The last audit failed: ${state.failure.message}` : ""),
    audit,
  };
}
