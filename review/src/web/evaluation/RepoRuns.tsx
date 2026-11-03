import React from "react";
import { useLocation } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { type EvaluationOptions, type EvaluationRun, evaluationRequest, runsRequest } from "./api";

/**
 * A repository's or benchmark's evaluation runs and the org's credentials, shared by the Results
 * page's table, the Run page's Missing Results, and the chart preview in the header. They load when
 * the Results or Run page opens, refresh each
 * time it opens again, and while a run is unfinished every 3 seconds there; elsewhere they rest.
 */
interface RepoRuns {
  url: string;
  runs: EvaluationRun[];
  credentials: CredentialInfo[];
  /** The tasks runs can use (a repository's accepted ones, or a benchmark's), once loaded. */
  accepted?: AcceptedTask[];
  loading: boolean;
  error: string;
  /** Whether the Results page is the one showing. */
  onResults: boolean;
  /**
   * Puts a freshly fetched run in place of its older copy, or first if the list lacks it; a
   * deleted run leaves the list.
   */
  update(run: EvaluationRun): void;
  /** Refreshes after submission, polling until the comparison's run record appears. */
  refresh(comparisonId: string): void;
}

/** A task runs can use, and when it was accepted, when the task list says. */
export type AcceptedTask = EvaluationOptions["tasks"][number] & { acceptedAt?: string };

const RepoRunsContext = React.createContext<RepoRuns | null>(null);

export function useRepoRuns(): RepoRuns {
  const context = React.useContext(RepoRunsContext);
  if (!context) throw new Error("useRepoRuns must be used under RepoRunsProvider");
  return context;
}

export function RepoRunsProvider({
  org,
  url,
  repo,
  children,
}: {
  org: string;
  /** The API the runs are under (useEvaluationScope). */
  url: string;
  /** `owner/name`, for a repository, whose reviews say when each task was accepted. */
  repo?: string;
  children: React.ReactNode;
}) {
  const [runs, setRuns] = React.useState<EvaluationRun[]>([]);
  const [credentials, setCredentials] = React.useState<CredentialInfo[]>([]);
  const [accepted, setAccepted] = React.useState<AcceptedTask[]>();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const { pathname } = useLocation();
  const onResults = /\/results\/?$/.test(pathname);
  // The Run page offers to fill the gaps in these runs, so it reads them too.
  const onRun = /\/run\/?$/.test(pathname);
  const showing = React.useRef(onResults);
  showing.current = onResults;
  const refreshNow = React.useRef<(comparisonId?: string) => void>(() => {});
  // Sign-ins and custom endpoints, for configurations and the chart. Pages work without them.
  React.useEffect(() => {
    let disposed = false;
    evaluationRequest<{ credentials: CredentialInfo[] }>(
      `/api/orgs/${encodeURIComponent(org)}/credentials`,
    )
      .then((result) => {
        if (!disposed) setCredentials(result.credentials);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [org]);
  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    // Only the latest request counts, so an early refresh never leaves two polls going.
    let latest = 0;
    // The list last received and its tag: a poll sends the tag, and an unchanged list is not
    // downloaded again.
    let listed: { runs: EvaluationRun[]; tag?: string } = { runs: [] };
    // Temporal accepts a submission before its worker writes the first run record.
    const awaiting = new Set<string>();
    setLoading(true);
    setRuns([]);
    setError("");
    const refresh = async () => {
      clearTimeout(timer);
      const request = ++latest;
      try {
        const result = await runsRequest(url, listed.tag);
        if (disposed || request !== latest) return;
        if (result) {
          listed = result;
          setRuns(result.runs);
        }
        setError("");
        setLoading(false);
        for (const run of listed.runs) {
          if (run.comparisonId) awaiting.delete(run.comparisonId);
        }
      } catch (cause) {
        if (!disposed && request === latest) {
          setError(cause instanceof Error ? cause.message : "Could not load results");
          setLoading(false);
        }
      } finally {
        if (
          !disposed &&
          request === latest &&
          (awaiting.size > 0 ||
            listed.runs.some((run) => run.status === "queued" || run.status === "running"))
        )
          timer = setTimeout(() => {
            if (showing.current) void refresh();
          }, 3000);
      }
    };
    refreshNow.current = (comparisonId) => {
      if (comparisonId) awaiting.add(comparisonId);
      void refresh();
    };
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [url]);
  // Opening the Results or Run page loads the runs, or refreshes them if they were loaded on an
  // earlier visit, so a comparison started on the Run page shows at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new repository's refresh replaces refreshNow, and must run.
  React.useEffect(() => {
    if (onResults || onRun) refreshNow.current();
  }, [onResults, onRun, url]);
  // The tasks runs can use, for the coverage view: which tasks a configuration hasn't run, and for
  // a repository, from the Dataset page's task list, when each was accepted, which says whether a
  // run left a task out or it came after. Reloaded each time the Results page opens, since a
  // repository's tasks are accepted elsewhere.
  React.useEffect(() => {
    if (!onResults) return;
    let disposed = false;
    const reviews = repo
      ? evaluationRequest<{
          tasks: { runId: string; taskId: string; review?: { decidedAt: string } }[];
        }>(`/api/orgs/${encodeURIComponent(org)}/repos/${repo}/tasks`).catch(() => ({ tasks: [] }))
      : Promise.resolve({ tasks: [] });
    Promise.all([evaluationRequest<EvaluationOptions>(`${url}/options`), reviews])
      .then(([options, list]) => {
        if (disposed) return;
        const decided = new Map(
          list.tasks.map((task) => [`${task.runId}/${task.taskId}`, task.review?.decidedAt]),
        );
        setAccepted(
          options.tasks.map((task) => {
            const acceptedAt = decided.get(`${task.runId}/${task.taskId}`);
            return acceptedAt ? { ...task, acceptedAt } : task;
          }),
        );
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [onResults, url, org, repo]);
  const refresh = React.useCallback((comparisonId: string) => refreshNow.current(comparisonId), []);
  const update = React.useCallback(
    (run: EvaluationRun) =>
      setRuns((history) =>
        run.deletedAt
          ? history.filter((entry) => entry.id !== run.id)
          : history.some((entry) => entry.id === run.id)
            ? history.map((entry) => (entry.id === run.id ? run : entry))
            : [run, ...history],
      ),
    [],
  );
  const value = React.useMemo(
    () => ({
      url,
      runs,
      credentials,
      ...(accepted ? { accepted } : {}),
      loading,
      error,
      onResults,
      update,
      refresh,
    }),
    [url, runs, credentials, accepted, loading, error, onResults, update, refresh],
  );
  return <RepoRunsContext.Provider value={value}>{children}</RepoRunsContext.Provider>;
}
