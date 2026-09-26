import type { DiscoveryShardProgress } from "../../../../src/contracts/index";
import { type BatchStatus, batchIsTerminal } from "../batch-api";
import { GenerationCost } from "../GenerationCost";
import { EmptyState, SectionHeader } from "../ui";
import { DiscoveryFeed } from "./DiscoveryFeed";

export function Discovery({ status }: { status: BatchStatus }) {
  const discovery = status.discovery;
  const shards = discovery?.shards ?? [];
  const preparing = status.phase === "preparing";
  const active = (preparing || status.phase === "discovering") && !batchIsTerminal(status.phase);
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
        <ul className="panel" aria-label="Discovery Shards">
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
          title={
            preparing
              ? "Collecting Merged PRs"
              : active
                ? "Starting Discovery"
                : "No Discovery Output"
          }
        >
          {preparing
            ? "Reading this repository's merged pull requests to plan discovery."
            : active
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
      <summary className="grid cursor-pointer list-none grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 px-4 py-3 text-sm font-semibold hover:bg-muted/60 [&::-webkit-details-marker]:hidden">
        <span className="text-muted-foreground before:content-['▸'] group-open/shard:before:content-['▾']" />
        <span>
          Shard {shard.shardIndex + 1}
          {status.discovery?.totalShards ? ` of ${status.discovery.totalShards}` : ""}
        </span>
        <span className="flex min-w-0 items-center gap-2 justify-self-end truncate text-right text-xs text-muted-foreground">
          <GenerationCost cost={shard.cost} />
          <span>
            {shard.attempt && shard.attempt > 1 ? `Attempt ${shard.attempt} · ` : ""}
            {label}
          </span>
        </span>
      </summary>
      <DiscoveryFeed runId={status.runId} shard={shard} active={running} />
    </details>
  );
}
