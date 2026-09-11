import React from "react";
import {
  type BatchRepoId,
  type BatchRun,
  type BatchStatus,
  batchIsTerminal,
  fetchBatch,
  listBatches,
} from "../batch-api";

interface BatchHistory {
  repoId: BatchRepoId;
  runs: BatchRun[] | null;
  statuses: Record<string, BatchStatus>;
  errors: Record<string, string>;
  error: string | null;
  refreshing: boolean;
  revision: number;
  refresh(): void;
}
const BatchContext = React.createContext<BatchHistory | null>(null);

/** Repository-level polling keeps generation progress available across creation, history and Dataset. */
export function BatchProvider({
  repoId,
  children,
}: {
  repoId: BatchRepoId;
  children: React.ReactNode;
}) {
  const { org, fullName } = repoId;
  const [runs, setRuns] = React.useState<BatchRun[] | null>(null);
  const [statuses, setStatuses] = React.useState<Record<string, BatchStatus>>({});
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(true);
  const [revision, setRevision] = React.useState(0);
  const refreshRef = React.useRef<() => void>(() => {});
  const refresh = React.useCallback(() => refreshRef.current(), []);
  React.useEffect(() => {
    let disposed = false;
    let fetching = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    const known = new Map<string, BatchStatus>();
    const failed = new Set<string>();
    const poll = async (force = false) => {
      if (disposed) return;
      if (fetching) {
        pending ||= force;
        return;
      }
      fetching = true;
      clearTimeout(timer);
      setRefreshing(true);
      let retrySoon = false;
      let changed = false;
      try {
        const result = await listBatches({ org, fullName });
        if (disposed) return;
        setRuns(result.batches);
        setError(null);
        for (const run of result.batches) {
          const previous = known.get(run.runId);
          if (!force && previous && batchIsTerminal(previous.phase) && !failed.has(run.runId))
            continue;
          try {
            const status = await fetchBatch({ org, fullName }, run.runId);
            if (disposed) return;
            changed ||= JSON.stringify(previous) !== JSON.stringify(status);
            known.set(run.runId, status);
            failed.delete(run.runId);
            setStatuses((current) => ({ ...current, [run.runId]: status }));
            setErrors((current) => {
              const next = { ...current };
              delete next[run.runId];
              return next;
            });
            retrySoon ||= !batchIsTerminal(status.phase);
          } catch (cause) {
            if (disposed) return;
            retrySoon = true;
            failed.add(run.runId);
            setErrors((current) => ({
              ...current,
              [run.runId]: cause instanceof Error ? cause.message : "Could not load batch status.",
            }));
          }
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Could not load batches.");
      } finally {
        fetching = false;
        if (!disposed) {
          if (changed) setRevision((value) => value + 1);
          setRefreshing(false);
          if (pending) {
            pending = false;
            void poll(true);
          } else timer = setTimeout(() => void poll(), retrySoon ? 5000 : 15000);
        }
      }
    };
    const onRefresh = () => {
      void poll(true);
    };
    refreshRef.current = onRefresh;
    window.addEventListener("focus", onRefresh);
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      refreshRef.current = () => {};
      window.removeEventListener("focus", onRefresh);
    };
  }, [org, fullName]);
  return (
    <BatchContext.Provider
      value={{ repoId, runs, statuses, errors, error, refreshing, revision, refresh }}
    >
      {children}
    </BatchContext.Provider>
  );
}

export function useBatches() {
  const history = React.useContext(BatchContext);
  if (!history) throw new Error("Batch history requires a repository context");
  return history;
}
