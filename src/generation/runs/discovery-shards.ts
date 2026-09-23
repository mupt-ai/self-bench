import type { ArtifactStore } from "../../artifacts/index.js";
import type { DiscoveryShardProgress } from "../../contracts/index.js";

const SHARD_PATH = /^wave-(\d+)\/shard-(\d+)\/attempt-(\d+)\/(?:live\/(\d+)\.json|modal\.log)$/;

interface ListedShard {
  wave: number;
  shardIndex: number;
  attempt: number;
  liveKey?: string;
  logKey?: string;
  liveSequence?: string;
}

export function listDiscoveryShards(
  entries: readonly { key: string }[],
  runId: string,
): DiscoveryShardProgress[] {
  const prefix = `runs/${runId}/discovery/`;
  const shards = new Map<string, ListedShard>();
  for (const entry of entries) {
    if (!entry.key.startsWith(prefix)) continue;
    const match = SHARD_PATH.exec(entry.key.slice(prefix.length).replace(/^\/+/, ""));
    if (!match?.[1] || !match[2] || !match[3]) continue;
    const wave = Number(match[1]);
    const shardIndex = Number(match[2]);
    const attempt = Number(match[3]);
    const id = `${wave}/${shardIndex}`;
    const current = shards.get(id);
    if (current && current.attempt > attempt) continue;
    const next: ListedShard =
      current && current.attempt === attempt ? { ...current } : { wave, shardIndex, attempt };
    if (match[4] !== undefined) {
      if (!next.liveSequence || match[4] >= next.liveSequence) {
        next.liveKey = entry.key;
        next.liveSequence = match[4];
      }
    } else next.logKey = entry.key;
    shards.set(id, next);
  }
  return [...shards.values()]
    .map(({ liveSequence: _liveSequence, ...shard }) => shard)
    .sort((left, right) => left.wave - right.wave || left.shardIndex - right.shardIndex);
}

export function mergeDiscoveryShards(
  known: readonly DiscoveryShardProgress[] | undefined,
  listed: readonly DiscoveryShardProgress[],
): DiscoveryShardProgress[] {
  const shards = new Map<string, DiscoveryShardProgress>();
  for (const shard of known ?? []) shards.set(`${shard.wave}/${shard.shardIndex}`, shard);
  for (const shard of listed) {
    const id = `${shard.wave}/${shard.shardIndex}`;
    const previous = shards.get(id);
    shards.set(id, {
      ...previous,
      ...shard,
      ...(previous?.error ? { error: previous.error } : {}),
    });
  }
  return [...shards.values()].sort(
    (left, right) => left.wave - right.wave || left.shardIndex - right.shardIndex,
  );
}

export async function loadDiscoveryShards(
  store: ArtifactStore,
  runId: string,
): Promise<DiscoveryShardProgress[]> {
  return listDiscoveryShards(await store.list(`runs/${runId}/discovery`).catch(() => []), runId);
}
