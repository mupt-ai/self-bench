import React from "react";
import { BatchProgress } from "./BatchProgress";
import {
  type BatchRepoId,
  type BatchRun,
  type BatchStatus,
  batchIsTerminal,
  type CandidateCounts,
  fetchBatch,
  listBatches,
  startBatch,
  validCandidateCounts,
} from "./batch-api";
import { buttonStyles, Input } from "./ui";
import { useModalDialog } from "./useModalDialog";

export interface GenerateBatchProps {
  repoId: BatchRepoId;
  disabled?: boolean;
  /** Refresh the parent task list after a start or progress sync. Keep this callback stable. */
  onStarted?: () => void;
}

/** Self-contained header action. Progress survives closing the sheet and reloading the page. */
export function GenerateBatch({ repoId, onStarted, disabled }: GenerateBatchProps) {
  const [open, setOpen] = React.useState(false);
  const [counts, setCounts] = React.useState<CandidateCounts>({ easy: 1, medium: 1, hard: 1 });
  const [runs, setRuns] = React.useState<BatchRun[]>([]);
  const [statuses, setStatuses] = React.useState<Record<string, BatchStatus>>({});
  const [error, setError] = React.useState<string>();
  const [busy, setBusy] = React.useState(false);
  const closeButton = React.useRef<HTMLButtonElement>(null);
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
      <button
        type="button"
        className={buttonStyles.secondary}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Generate Batch{active > 0 ? ` (${active})` : ""}
      </button>
      {open && (
        <BatchDialog initialFocus={closeButton} busy={busy} onClose={() => setOpen(false)}>
          <header className="flex items-start justify-between gap-4 border-b border-line p-5">
            <div>
              <h2 id="generate-batch-title" className="text-lg font-semibold">
                Generate Candidates
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted">
                For {fullName}. Counts are generation targets, not guaranteed accepted tasks.
                Successful pipeline tasks enter Needs Review, never human-approved automatically.
              </p>
            </div>
            <button
              ref={closeButton}
              type="button"
              className={buttonStyles.ghost}
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </header>
          <form
            className="grid grid-cols-3 items-end gap-3 p-5"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {(
              [
                { tier: "easy", label: "Easy" },
                { tier: "medium", label: "Medium" },
                { tier: "hard", label: "Hard" },
              ] as const
            ).map(({ tier, label }) => (
              <label
                key={tier}
                htmlFor={`batch-${tier}`}
                className="grid gap-2 text-sm font-medium"
              >
                {label}
                <Input
                  id={`batch-${tier}`}
                  aria-label={`${label} Candidates`}
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
              className={`${buttonStyles.primary} col-span-3`}
              disabled={busy || !validCandidateCounts(counts)}
            >
              {busy ? "Starting…" : "Generate"}
            </button>
          </form>
          <div className="space-y-4 px-5 pb-5">
            <p className="text-sm leading-6 text-muted">
              1–10,000 candidates total. Uses the configured generation worker and its repository
              credentials.
            </p>
            {error && (
              <p className="text-sm leading-6 text-danger" role="alert">
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
        </BatchDialog>
      )}
    </>
  );
}

function BatchDialog({
  children,
  initialFocus,
  busy,
  onClose,
}: {
  children: React.ReactNode;
  initialFocus: React.RefObject<HTMLButtonElement | null>;
  busy: boolean;
  onClose(): void;
}) {
  const dialog = useModalDialog(initialFocus);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="generate-batch-title"
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl overflow-auto border border-line-strong bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/65"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
