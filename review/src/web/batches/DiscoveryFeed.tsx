import { useEffect, useState } from "react";
import { type AgentFeedEvent, agentFeedEvents } from "../../../../src/agent-feed";
import type { DiscoveryShardProgress } from "../../../../src/contracts";
import { AgentTraceEvent } from "../../components/AgentTraceEvent";
import { createApiClient } from "../../sources/types";

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
        <p className="m-0 px-4 py-1.5 text-[11px] text-muted-foreground">
          Updated {formatCapturedAt(capturedAt)}
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
        {events.map((event, eventIndex) => (
          <AgentTraceEvent
            // Feed events have no IDs; the index disambiguates repeated streaming snapshots.
            // biome-ignore lint/suspicious/noArrayIndexKey: rows contain no local state.
            key={`${event.kind}:${event.timestamp ?? ""}:${(event.text ?? "").slice(0, 32)}:${eventIndex}`}
            event={event}
          />
        ))}
      </div>
    </div>
  );
}

function formatCapturedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}
