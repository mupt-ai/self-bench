import React from "react";
import { type AgentFeedEvent, agentFeedEvents } from "../../../src/agent-feed";
import { loading, notice, sheetBody } from "../components/viewer-ui";
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
    <div className={sheetBody}>
      {error && (
        <p className={`${notice} site:p-0! !text-(--bad-fg) site:!text-danger`} role="alert">
          {error}
        </p>
      )}
      {row.reason && (
        <p className={`${notice} site:p-0! !text-(--bad-fg) site:!text-danger`}>{row.reason}</p>
      )}
      {!artifacts && !error && <p className={`${loading} site:p-0!`}>Loading agent activity…</p>}
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
        />
      ))}
    </div>
  );
}

function AgentPart({
  round,
  source,
  active,
}: {
  round: AgentRound;
  source: TaskSource;
  active: boolean;
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
  const done = Boolean(round.session || round.result);
  return (
    <details className="group/part border border-line [&+&]:mt-3">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 font-mono text-[13px] font-medium text-ink before:text-dim before:content-['▸'] group-open/part:before:content-['▾'] [&::-webkit-details-marker]:hidden site:text-sm site:leading-normal">
        <span>{round.title}</span>
        <span className="font-mono text-[11px] text-dim site:text-sm site:leading-normal">
          {round.attempt > 1 ? `Attempt ${round.attempt} · ` : ""}
          {done ? "Finished" : active ? "In Progress" : "Stopped"}
        </span>
      </summary>
      <div className="border-t border-line">
        {capturedAt && (
          <p className="m-0 px-4 py-2.5 font-mono text-[11px] leading-[normal] text-dim site:text-sm site:leading-normal">
            Last Output · {new Date(capturedAt).toLocaleTimeString()}
          </p>
        )}
        {error && (
          <p className={`${notice} !text-(--bad-fg) site:!text-danger`}>
            Could not load agent output
          </p>
        )}
        {!error && events.length === 0 && (
          <p className={notice}>
            {done ? "No agent output available." : "Waiting for agent output…"}
          </p>
        )}
        <div className="max-h-[560px] overflow-auto">
          {events.map((event, eventIndex) => {
            const key = `${event.kind}:${event.timestamp ?? ""}:${event.text.slice(0, 32)}:${eventIndex}`;
            return event.kind === "message" ? (
              <div
                className="border-t border-line px-4 py-3 first:border-t-0 [&_pre]:m-0 [&_pre]:font-mono [&_pre]:text-xs [&_pre]:leading-[1.6] [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere [&_pre]:text-ink site:[&_pre]:text-base [&_time]:float-right [&_time]:font-mono [&_time]:text-[11px] [&_time]:text-dim site:[&_time]:text-sm site:[&_time]:leading-normal"
                key={key}
              >
                <span className="mb-2 block font-mono text-[11px] leading-[normal] text-mint site:text-sm site:leading-normal">
                  Agent Message
                </span>
                {event.timestamp && (
                  <time dateTime={event.timestamp}>{formatEventTime(event.timestamp)}</time>
                )}
                <pre>{event.text}</pre>
              </div>
            ) : (
              <details
                className="group/event border-t border-line px-4 py-3 first:border-t-0 [&_pre]:m-0 [&_pre]:font-mono [&_pre]:text-xs [&_pre]:leading-[1.6] [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere [&_pre]:text-ink site:[&_pre]:text-sm site:[&_pre]:leading-6 [&_time]:float-right [&_time]:font-mono [&_time]:text-[11px] [&_time]:text-dim site:[&_time]:text-sm site:[&_time]:leading-normal"
                key={key}
              >
                <summary className="cursor-pointer list-none font-mono text-xs leading-[normal] text-muted [&::-webkit-details-marker]:hidden [&>span:first-child]:mr-2.5 [&>span:first-child]:inline site:text-sm site:leading-normal">
                  <span className="mb-2 block font-mono text-[11px] leading-[normal] text-mint site:text-sm site:leading-normal">
                    {event.kind === "tool" ? "Tool Call" : "Tool Output"}
                  </span>
                  {event.timestamp && (
                    <time dateTime={event.timestamp}>{formatEventTime(event.timestamp)}</time>
                  )}
                  <span className="font-mono text-[11px] leading-[normal] text-muted site:text-sm site:leading-normal">
                    {event.text.split("\n")[0] || "(empty)"}
                  </span>
                </summary>
                <pre>{event.text}</pre>
              </details>
            );
          })}
        </div>
      </div>
    </details>
  );
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString();
}
