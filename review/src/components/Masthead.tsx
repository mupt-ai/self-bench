import { formatTime } from "../lib/format";
import type { TaskSource } from "../sources/types";
import type { RunSummary, ViewerInfo } from "../types";
import { viewerButton, viewerField } from "./viewer-ui";

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
    <header className="flex min-w-0 items-center border-b border-(--border) bg-(--background)">
      <div className="flex h-full w-(--tasks-w) shrink-0 items-center gap-2.5 border-r border-(--border) px-6 whitespace-nowrap max-[1100px]:w-auto">
        <span
          className="relative size-4 shrink-0 border border-(--brand) after:absolute after:inset-1 after:bg-(--brand) after:content-['']"
          aria-hidden="true"
        />
        <span className="text-sm font-semibold tracking-[0.02em]">Harbor Ledger</span>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-3 px-6 before:text-[11px] before:tracking-[0.18em] before:text-(--muted-fg) before:uppercase before:content-['source']">
        {props.mode === "runs" ? (
          <>
            <select
              className={`${viewerField} min-w-[280px] max-w-[46vw]`}
              value={props.runId}
              onChange={(event) => props.onRun(event.target.value)}
              aria-label="Run"
            >
              <option value="">— Pick a Run —</option>
              {props.runs.map((run) => (
                <option key={run.runId} value={run.runId}>
                  {run.runId} · {run.status.toLowerCase()}
                  {run.startedAt ? ` · ${formatTime(run.startedAt)}` : ""}
                </option>
              ))}
            </select>
            <button type="button" className={viewerButton} onClick={props.onRefreshRuns}>
              Refresh
            </button>
          </>
        ) : (
          <span
            className="min-w-0 truncate text-[13px] text-(--foreground) site:font-mono site:text-sm"
            title={props.info?.root}
          >
            {props.info?.root ?? "no directory"}
          </span>
        )}
        {props.source?.summary && (
          <span className="min-w-0 shrink-0 truncate text-[13px] text-(--muted-fg)">
            {props.source.summary}
          </span>
        )}
      </div>
      <div className="ml-auto flex items-center gap-2.5 pr-6">
        {props.error && (
          <span className="max-w-[40vw] truncate text-[13px] text-(--bad-fg)" title={props.error}>
            {props.error}
          </span>
        )}
        {props.busy && (
          <span className="min-w-0 truncate text-[13px] text-(--foreground)">working…</span>
        )}
        {props.mode === "runs" && (
          <input
            className={viewerField}
            type="password"
            value={props.token}
            onChange={(event) => props.onToken(event.target.value)}
            placeholder="API Token"
            aria-label="API Token"
          />
        )}
      </div>
    </header>
  );
}
