import React from "react";
import { type AgentFeedEvent, agentFeedEvents } from "../../../src/harnesses/pi/agent-feed";
import { AgentTraceEvent } from "../components/AgentTraceEvent";
import { notice, sheetBody } from "../components/viewer-ui";
import { type AgentRound, agentRounds } from "../lib/agent-rounds";
import type { TaskSource } from "../sources/types";
import type { CandidateArtifacts, TaskRow } from "../types";

export function AgentWorkSheet({ source, row }: { source: TaskSource; row: TaskRow }) {
  const [artifacts, setArtifacts] = React.useState<CandidateArtifacts | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await source.artifacts?.(row.id);
        if (!stopped && result) {
          setArtifacts(result);
          setError(null);
        }
      } catch {
        if (!stopped) setError("Could not refresh agent activity");
      }
      if (!stopped) timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [source, row.id]);
  const rounds = artifacts ? agentRounds(artifacts) : [];
  return (
    <div className={`${sheetBody} !gap-2`}>
      {error && (
        <p className={`${notice} site:p-0! !text-(--bad-fg) site:!text-destructive`} role="alert">
          {error}
        </p>
      )}
      {row.reason && (
        <p className={`${notice} site:p-0! !text-(--bad-fg) site:!text-destructive`}>
          {row.reason}
        </p>
      )}
      {!artifacts && !error && <p className={`${notice} site:p-0!`}>Loading agent activity…</p>}
      {artifacts && rounds.length === 0 && (
        <p className={`${notice} site:p-0!`}>No agent activity yet.</p>
      )}
      {rounds.map((round) => (
        <AgentPart
          key={round.id}
          round={round}
          source={source}
          active={
            row.status === "in_progress" || row.status === "authoring" || row.status === "verifying"
          }
          failed={row.status === "infrastructure_failed"}
        />
      ))}
    </div>
  );
}

function AgentPart({
  round,
  source,
  active,
  failed,
}: {
  round: AgentRound;
  source: TaskSource;
  active: boolean;
  failed: boolean;
}) {
  const [events, setEvents] = React.useState<AgentFeedEvent[]>([]);
  const [error, setError] = React.useState(false);
  const [capturedAt, setCapturedAt] = React.useState<string>();
  const entry = round.live ?? round.session;
  React.useEffect(() => {
    if (!entry || !source.readArtifact) return;
    let stopped = false;
    const start = entry === round.session ? Math.max(0, entry.sizeBytes - 262144) : 0;
    void source
      .readArtifact(entry.key, start ? { start } : undefined)
      .then((text) => {
        if (stopped) return;
        if (entry === round.live) {
          const snapshot = JSON.parse(text) as { events: AgentFeedEvent[]; capturedAt: string };
          setEvents(snapshot.events);
          setCapturedAt(snapshot.capturedAt);
        } else {
          setEvents(agentFeedEvents(text));
          setCapturedAt(entry.updatedAt);
        }
        setError(false);
      })
      .catch(() => {
        if (!stopped) setError(true);
      });
    return () => {
      stopped = true;
    };
  }, [entry, source, round.live, round.session]);
  const done = Boolean(round.session) || round.status === "finished";
  const status =
    round.status === "failed" || (failed && !round.status && !active)
      ? "Failed"
      : round.status === "finished" || done
        ? "Finished"
        : active
          ? "In Progress"
          : "Stopped";
  return (
    <details className="group/part panel">
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-x-2 px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-foreground/40 [&::-webkit-details-marker]:hidden sm:px-4">
        <span
          aria-hidden="true"
          className="shrink-0 text-[10px] text-muted-foreground before:content-['▸'] group-open/part:before:content-['▾']"
        />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {round.title}
        </span>
        <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
          {round.attempt > 1 ? `Attempt ${round.attempt} · ` : ""}
          {status}
        </span>
      </summary>
      <div className="border-t border-border">
        {capturedAt && (
          <p className="m-0 border-b border-border px-3 py-1.5 text-[11px] text-muted-foreground sm:px-4">
            Updated {formatCapturedAt(capturedAt)}
          </p>
        )}
        {error && (
          <p className={`${notice} !text-(--bad-fg) site:!text-destructive`}>
            Could not load agent output
          </p>
        )}
        {!error && events.length === 0 && (
          <p className={notice}>
            {done ? "No agent output available." : "Waiting for agent output…"}
          </p>
        )}
        <div className="max-h-[560px] overflow-auto">
          {events.map((event, eventIndex) => (
            <AgentTraceEvent
              // Feed events have no IDs; the index disambiguates repeated streaming snapshots.
              // biome-ignore lint/suspicious/noArrayIndexKey: rows contain no local state.
              key={`${event.kind}:${event.timestamp ?? ""}:${event.text.slice(0, 32)}:${eventIndex}`}
              event={event}
            />
          ))}
        </div>
      </div>
    </details>
  );
}

function formatCapturedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
