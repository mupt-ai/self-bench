import { useEffect, useState } from "react";
import { type AgentFeedEvent, agentFeedEvents } from "../../../../src/agent-feed";
import type { DiscoveryShardProgress } from "../../../../src/contracts";
import { createApiClient } from "../../sources/types";
import { cn } from "../primitives/cn";

const api = createApiClient("");

export function DiscoveryFeed({
  runId,
  shard,
  active,
}: {
  runId: string;
  shard: DiscoveryShardProgress;
  active: boolean;
}) {
  const [events, setEvents] = useState<AgentFeedEvent[]>([]);
  const [capturedAt, setCapturedAt] = useState<string>();
  const [error, setError] = useState(false);
  const key = shard.liveKey ?? shard.logKey;
  useEffect(() => {
    if (!key) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const text = await api.text(
          `/v1/runs/${encodeURIComponent(runId)}/artifacts?key=${encodeURIComponent(key)}`,
        );
        if (stopped) return;
        if (shard.liveKey && key === shard.liveKey) {
          const snapshot = JSON.parse(text) as { events?: AgentFeedEvent[]; capturedAt?: string };
          setEvents(Array.isArray(snapshot.events) ? snapshot.events : []);
          if (snapshot.capturedAt) setCapturedAt(snapshot.capturedAt);
        } else {
          setEvents(agentFeedEvents(text));
        }
        setError(false);
      } catch {
        if (!stopped) setError(true);
      }
      if (!stopped && active) timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [runId, key, shard.liveKey, active]);
  if (!key && !shard.error) {
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">
        {active ? "Waiting for agent output…" : "No agent output available."}
      </p>
    );
  }
  return (
    <div className="border-t border-border">
      {capturedAt && (
        <p className="m-0 px-4 py-2.5 text-xs text-muted-foreground">
          Last Output · {new Date(capturedAt).toLocaleTimeString()}
        </p>
      )}
      {shard.error && (
        <p className="border-t border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          {shard.error}
        </p>
      )}
      {error && <p className="px-4 py-3 text-xs text-destructive">Could not load agent output.</p>}
      {!error && events.length === 0 && !shard.error && (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          {active ? "Waiting for agent output…" : "No agent output available."}
        </p>
      )}
      <div className="max-h-[560px] overflow-auto">
        {events.map((event) => (
          <FeedEvent
            key={`${event.kind}:${event.timestamp ?? ""}:${(event.text ?? "").slice(0, 32)}`}
            event={event}
          />
        ))}
      </div>
    </div>
  );
}

function FeedEvent({ event }: { event: AgentFeedEvent }) {
  const time = event.timestamp ? new Date(event.timestamp) : undefined;
  const stamp = time && !Number.isNaN(time.getTime()) ? time.toLocaleTimeString() : "";
  if (event.kind === "message" || event.kind === "error") {
    return (
      <div className="border-t border-border px-4 py-3">
        <span
          className={cn(
            "mb-2 block text-xs",
            event.kind === "error" ? "text-destructive" : "text-brand",
          )}
        >
          {event.kind === "error" ? "Provider Error" : "Agent Message"}
        </span>
        {stamp && <time className="float-right text-xs text-muted-foreground">{stamp}</time>}
        <pre className="m-0 font-mono text-xs leading-[1.6] wrap-anywhere whitespace-pre-wrap text-foreground">
          {event.text}
        </pre>
      </div>
    );
  }
  return (
    <details className="group/event border-t border-border px-4 py-3">
      <summary className="cursor-pointer list-none text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
        <span className="mb-2 block text-xs text-brand">
          {event.kind === "tool" ? "Tool Call" : "Tool Output"}
        </span>
        {stamp && <time className="float-right text-xs text-muted-foreground">{stamp}</time>}
        <span>{event.text.split("\n")[0] || "(empty)"}</span>
      </summary>
      <pre className="m-0 mt-2 font-mono text-xs leading-[1.6] wrap-anywhere whitespace-pre-wrap text-foreground">
        {event.text}
      </pre>
    </details>
  );
}
