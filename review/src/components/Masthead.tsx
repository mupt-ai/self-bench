import { formatTime } from "../lib/format";
import type { TaskSource } from "../sources/types";
import type { RunSummary, ViewerInfo } from "../types";

export type Mode = "runs" | "local";

export interface MastheadProps {
  info: ViewerInfo | null;
  needsToken: boolean;
  mode: Mode;
  runs: RunSummary[];
  runId: string;
  onRun: (runId: string) => void;
  onRefreshRuns: () => void;
  token: string;
  onToken: (token: string) => void;
  source: TaskSource | null;
  busy: boolean;
  error: string | null;
}

export function Masthead(props: MastheadProps) {
  return (
    <header className="masthead">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">Harbor Ledger</span>
      </div>
      <div className="mast-controls">
        {props.mode === "runs" ? (
          <>
            <select
              className="field"
              value={props.runId}
              onChange={(event) => props.onRun(event.target.value)}
              aria-label="Run"
            >
              <option value="">— pick a run —</option>
              {props.runs.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {run.runId} · {run.status.toLowerCase()}
                  {run.startedAt ? ` · ${formatTime(run.startedAt)}` : ""}
                </option>
              ))}
            </select>
            <button type="button" className="btn" onClick={props.onRefreshRuns}>
              Refresh
            </button>
          </>
        ) : (
          <span className="mast-note path" title={props.info?.root}>
            {props.info?.root ?? "no directory"}
          </span>
        )}
        {props.source?.summary && <span className="mast-note">{props.source.summary}</span>}
      </div>
      <div className="mast-right">
        {props.error && (
          <span className="error-line" title={props.error}>
            {props.error}
          </span>
        )}
        {props.busy && <span className="mast-note">working…</span>}
        {props.mode === "runs" && (
          <input
            className="field"
            type="password"
            value={props.token}
            onChange={(event) => props.onToken(event.target.value)}
            placeholder="API token"
            aria-label="API token"
          />
        )}
      </div>
    </header>
  );
}
