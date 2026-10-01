import React from "react";
import { useLocation } from "react-router";
import type { CredentialInfo } from "../../../../src/db/credentials";
import {
  type EvaluationOptions,
  type EvaluationRun,
  evaluationRequest,
  evaluationUrl,
} from "./api";

/**
 * A repository's evaluation runs and the org's credentials, shared by the Results page's table and
 * the chart preview in the repository header. They load when the Results page opens, refresh each
 * time it opens again, and while a run is unfinished every 3 seconds there; elsewhere they rest.
 */
interface RepoRuns {
  url: string;
  runs: EvaluationRun[];
  credentials: CredentialInfo[];
  /** The repository's accepted tasks, which runs can use, once loaded. */
  accepted?: AcceptedTask[];
  loading: boolean;
  error: string;
  /** Whether the Results page is the one showing. */
  onResults: boolean;
  /** Puts a freshly fetched run in place of its older copy. */
  update(run: EvaluationRun): void;
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
  repo,
  children,
}: {
  org: string;
  repo: string;
  children: React.ReactNode;
}) {
  const url = evaluationUrl(org, repo);
  const [runs, setRuns] = React.useState<EvaluationRun[]>([]);
  const [credentials, setCredentials] = React.useState<CredentialInfo[]>([]);
  const [accepted, setAccepted] = React.useState<AcceptedTask[]>();
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const onResults = /\/results\/?$/.test(useLocation().pathname);
  const showing = React.useRef(onResults);
  showing.current = onResults;
  const refreshNow = React.useRef<() => void>(() => {});
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
    setLoading(true);
    setRuns([]);
    setError("");
    const refresh = async () => {
      clearTimeout(timer);
      const request = ++latest;
      try {
        const result = await evaluationRequest<{ runs: EvaluationRun[] }>(url);
        if (disposed || request !== latest) return;
        setRuns(result.runs);
        setError("");
        setLoading(false);
        if (result.runs.some((run) => run.status === "queued" || run.status === "running"))
          timer = setTimeout(() => {
            if (showing.current) void refresh();
          }, 3000);
      } catch (cause) {
        if (!disposed && request === latest) {
          setError(cause instanceof Error ? cause.message : "Could not load results");
          setLoading(false);
        }
      }
    };
    refreshNow.current = () => void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [url]);
  // Opening the Results page loads the runs, or refreshes them if they were loaded on an earlier
  // visit, so a comparison started on the Run page shows at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new repository's refresh replaces refreshNow, and must run.
  React.useEffect(() => {
    if (onResults) refreshNow.current();
  }, [onResults, url]);
  // The accepted tasks, for the coverage view: which tasks a configuration hasn't run, and from the
  // Dataset page's task list, when each was accepted, which says whether a run left a task out or
  // it came after. Reloaded each time the Results page opens, since tasks are accepted elsewhere.
  React.useEffect(() => {
    if (!onResults) return;
    let disposed = false;
    const reviews = evaluationRequest<{
      tasks: { runId: string; taskId: string; review?: { decidedAt: string } }[];
    }>(`/api/orgs/${encodeURIComponent(org)}/repos/${repo}/tasks`).catch(() => ({ tasks: [] }));
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
  const update = React.useCallback(
    (run: EvaluationRun) =>
      setRuns((history) => history.map((entry) => (entry.id === run.id ? run : entry))),
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
    }),
    [url, runs, credentials, accepted, loading, error, onResults, update],
  );
  return <RepoRunsContext.Provider value={value}>{children}</RepoRunsContext.Provider>;
}
