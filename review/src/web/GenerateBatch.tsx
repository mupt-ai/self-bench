import React from "react";
import {
  type BatchRepoId,
  type BatchRun,
  type BatchStatus,
  batchIsTerminal,
  type CandidateCounts,
  cancelBatch,
  fetchBatch,
  listBatches,
  startBatch,
  validCandidateCounts,
} from "./batch-api";

export interface GenerateBatchProps {
  repoId: BatchRepoId;
  /** Refresh the parent task list after a start or progress sync. Keep this callback stable. */
  onStarted?: () => void;
}

/** Self-contained header action. Progress survives closing the sheet and reloading the page. */
export function GenerateBatch({ repoId, onStarted }: GenerateBatchProps) {
  const [open, setOpen] = React.useState(false);
  const [counts, setCounts] = React.useState<CandidateCounts>({ easy: 1, medium: 1, hard: 1 });
  const [runs, setRuns] = React.useState<BatchRun[]>([]);
  const [statuses, setStatuses] = React.useState<Record<string, BatchStatus>>({});
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const panel = React.useRef<HTMLElement>(null);
  const callback = React.useRef(onStarted);
  callback.current = onStarted;
  const { org, fullName } = repoId;
  const refreshRuns = React.useCallback(async () => {
    const result = await listBatches({ org, fullName });
    setRuns(result.batches);
  }, [org, fullName]);
  React.useEffect(() => {
    let disposed = false;
    listBatches({ org, fullName }).then(
      (result) => !disposed && setRuns(result.batches),
      (cause) => !disposed && setError(String(cause.message)),
    );
    return () => {
      disposed = true;
    };
  }, [org, fullName]);

  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const settled = new Set<string>();
    const poll = async () => {
      let changed = false;
      for (const run of runs) {
        if (disposed || settled.has(run.runId)) continue;
        try {
          const status = await fetchBatch({ org, fullName }, run.runId);
          if (disposed) return;
          setStatuses((current) => ({ ...current, [run.runId]: status }));
          if (batchIsTerminal(status.phase)) settled.add(run.runId);
          changed = true;
        } catch (cause) {
          if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
      if (!disposed) {
        if (changed) callback.current?.();
        if (settled.size < runs.length) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [runs, org, fullName]);

  React.useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLInputElement>("input")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key !== "Tab") return;
      const controls = panel.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input, [tabindex='0']",
      );
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open]);

  const submit = async () => {
    if (busy || !validCandidateCounts(counts)) return;
    setBusy(true);
    setError(undefined);
    try {
      await startBatch({ org, fullName }, counts);
      await refreshRuns();
      callback.current?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // Ambiguous starts remain associated server-side; show them before allowing a retry.
      await refreshRuns().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };
  const active = runs.filter(
    (run) => !batchIsTerminal(statuses[run.runId]?.phase ?? "queued"),
  ).length;
  return (
    <>
      <button ref={trigger} type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        Generate Batch{active > 0 ? ` (${active})` : ""}
      </button>
      {open && (
        <div
          className="sheet-overlay"
          onPointerDown={(event) => event.target === event.currentTarget && setOpen(false)}
        >
          <aside
            ref={panel}
            className="sheet-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="generate-batch-title"
          >
            <header className="sheet-head">
              <div>
                <div className="eyebrow">Generate Batch</div>
                <h2 id="generate-batch-title">Generate Candidates</h2>
                <p className="sheet-sub">
                  For {fullName}. Counts are generation targets, not guaranteed accepted tasks.
                  Successful pipeline tasks enter Needs Review, never human-approved automatically.
                </p>
              </div>
              <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
                Close
              </button>
            </header>
            <form
              className="sheet-lookup"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              {(["easy", "medium", "hard"] as const).map((tier) => (
                <label key={tier}>
                  {tier[0].toUpperCase() + tier.slice(1)}
                  <input
                    className="sheet-search"
                    aria-label={`${tier} candidates`}
                    type="number"
                    min="0"
                    max="10000"
                    step="1"
                    required
                    value={Number.isNaN(counts[tier]) ? "" : counts[tier]}
                    disabled={busy}
                    onChange={(event) =>
                      setCounts((current) => ({ ...current, [tier]: event.target.valueAsNumber }))
                    }
                  />
                </label>
              ))}
              <button
                type="submit"
                className="btn-primary"
                disabled={busy || !validCandidateCounts(counts)}
              >
                {busy ? "Starting…" : "Generate"}
              </button>
            </form>
            <div className="repo-list">
              <p className="repo-note">
                1–10,000 candidates total. Uses the configured generation worker and its repository
                credentials.
              </p>
              {error && (
                <p className="repo-note error" role="alert">
                  {error}
                </p>
              )}
              {runs.map((run) => (
                <BatchProgress
                  key={run.runId}
                  run={run}
                  status={statuses[run.runId]}
                  repoId={{ org, fullName }}
                />
              ))}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

function BatchProgress({
  run,
  status,
  repoId,
}: {
  run: BatchRun;
  status?: BatchStatus;
  repoId: BatchRepoId;
}) {
  const [cancelling, setCancelling] = React.useState(false);
  const [error, setError] = React.useState<string>();
  return (
    <section className="repo-note" aria-label={`Batch ${run.runId}`}>
      <p className="mono">{run.runId}</p>
      <p role="status">
        {status?.phase ?? "Loading progress…"}
        {status?.discovered !== undefined &&
          ` · ${status.discovered} discovered · ${status.accepted ?? 0} pipeline passed`}
      </p>
      {status?.discovery && (
        <p>
          Discovery wave {status.discovery.wave + 1}: {status.discovery.completedShards}/
          {status.discovery.totalShards} shards complete · {status.discovery.failedShards} failed
        </p>
      )}
      {status?.error && <p className="error">{status.error}</p>}
      {status?.phase === "blocked" && !status.error && (
        <p className="error">Discovery could not fill the requested candidate pool.</p>
      )}
      {!!status?.tasks?.length && (
        <ul>
          {status.tasks.map((task) => (
            <li key={task.candidateId}>
              {task.taskId} · {task.difficulty} ·{" "}
              {task.status === "accepted"
                ? "Needs Review"
                : `${task.status}${task.stage ? ` / ${task.stage}` : ""}`}
              {task.round !== undefined && ` · round ${task.round}`}
              {task.reason && <p className="error">{task.reason}</p>}
            </li>
          ))}
        </ul>
      )}
      {(!status || !batchIsTerminal(status.phase)) && (
        <button
          type="button"
          className="btn-ghost"
          disabled={cancelling}
          onClick={async () => {
            setCancelling(true);
            setError(undefined);
            try {
              await cancelBatch(repoId, run.runId);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
              setCancelling(false);
            }
          }}
        >
          {cancelling ? "Cancellation requested…" : "Cancel batch"}
        </button>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
