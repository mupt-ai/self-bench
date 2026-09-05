import React from "react";
import { type AgentFeedEvent, agentFeedEvents } from "../../../src/agent-feed";
import { type AgentRound, agentRounds } from "../lib/agent-rounds";
import type { TaskSource } from "../sources/types";
import type { CandidateArtifacts, TaskRow } from "../types";
import "./agent-work.css";

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
    <div className="sheet-body agent-work">
      {error && (
        <p className="notice bad" role="alert">
          {error}
        </p>
      )}
      {row.reason && <p className="notice bad">{row.reason}</p>}
      {!artifacts && !error && <p className="loading">Loading agent activity…</p>}
      {artifacts && rounds.length === 0 && <p className="notice">No agent activity yet.</p>}
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
    <details className="agent-part">
      <summary className="agent-part-head">
        <span>{round.title}</span>
        <span className="agent-part-status">
          {round.attempt > 1 ? `Attempt ${round.attempt} · ` : ""}
          {done ? "Finished" : active ? "In Progress" : "Stopped"}
        </span>
      </summary>
      <div className="agent-part-body">
        {capturedAt && (
          <p className="agent-captured">
            Last output · {new Date(capturedAt).toLocaleTimeString()}
          </p>
        )}
        {error && <p className="notice bad">Could not load agent output</p>}
        {!error && events.length === 0 && (
          <p className="notice">
            {done ? "No agent output available." : "Waiting for agent output…"}
          </p>
        )}
        <div className="agent-events">
          {events.map((event, eventIndex) => {
            const key = `${event.kind}:${event.timestamp ?? ""}:${event.text.slice(0, 32)}:${eventIndex}`;
            return event.kind === "message" ? (
              <div className="agent-event message" key={key}>
                <span className="agent-event-label">Agent Message</span>
                {event.timestamp && (
                  <time dateTime={event.timestamp}>{formatEventTime(event.timestamp)}</time>
                )}
                <pre>{event.text}</pre>
              </div>
            ) : (
              <details className={`agent-event ${event.kind}`} key={key}>
                <summary>
                  <span className="agent-event-label">
                    {event.kind === "tool" ? "Tool Call" : "Tool Output"}
                  </span>
                  {event.timestamp && (
                    <time dateTime={event.timestamp}>{formatEventTime(event.timestamp)}</time>
                  )}
                  <span className="agent-event-preview">
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
