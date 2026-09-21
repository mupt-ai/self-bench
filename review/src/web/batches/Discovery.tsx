import type { DiscoveryShardProgress } from "../../../../src/contracts";
import { type BatchStatus, batchIsTerminal } from "../batch-api";
import { EmptyState, SectionHeader } from "../ui";
import { DiscoveryFeed } from "./DiscoveryFeed";

export function Discovery({ status }: { status: BatchStatus }) {
  const discovery = status.discovery;
  const shards = discovery?.shards ?? [];
  const active = status.phase === "discovering" && !batchIsTerminal(status.phase);
  if (!active && shards.length === 0 && !(discovery?.totalShards ?? 0)) return null;
  const completed = discovery?.completedShards ?? shards.filter((shard) => !shard.error).length;
  const total = discovery?.totalShards || shards.length;
  return (
    <section className="mt-6" aria-label="Discovery">
      <SectionHeader title="Discovery">
        <span className="text-xs text-muted-foreground">
          {total ? `${completed}/${total} Shards` : "Starting"}
          {discovery?.candidates ? ` · ${discovery.candidates} Candidates` : ""}
        </span>
      </SectionHeader>
      {shards.length ? (
        <ul className="border border-border bg-card" aria-label="Discovery Shards">
          {shards.map((shard) => (
            <li
              key={`${shard.wave}-${shard.shardIndex}`}
              className="border-t border-border first:border-t-0"
            >
              <Shard status={status} shard={shard} active={active} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          className="border-solid"
          title={active ? "Starting Discovery" : "No Discovery Output"}
        >
          {active
            ? "The discovery sandbox is starting. Agent output will appear here."
            : "This batch has no discovery traces."}
        </EmptyState>
      )}
    </section>
  );
}

function Shard({
  status,
  shard,
  active,
}: {
  status: BatchStatus;
  shard: DiscoveryShardProgress;
  active: boolean;
}) {
  const running = active && !shard.error;
  const label = shard.error ? "Failed" : running ? "In Progress" : "Finished";
  return (
    <details className="group/shard">
      <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span className="text-muted-foreground before:content-['▸'] group-open/shard:before:content-['▾']" />
        <span>
          Shard {shard.shardIndex + 1}
          {status.discovery?.totalShards ? ` of ${status.discovery.totalShards}` : ""}
        </span>
        <span className="min-w-0 justify-self-end truncate text-right text-xs text-muted-foreground">
          {shard.attempt && shard.attempt > 1 ? `Attempt ${shard.attempt} · ` : ""}
          {label}
        </span>
      </summary>
      <DiscoveryFeed runId={status.runId} shard={shard} active={running} />
    </details>
  );
}
