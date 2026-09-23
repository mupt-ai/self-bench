import { DISCOVERY_POOL_MULTIPLIER } from "../../contracts/config/execution-limits.js";
import type { ProvenanceMessage } from "../../third_party/github/provenance.js";

const DEFAULT_PRS_PER_SHARD = 25;

/** Size each shard to expose a 1.5× PR pool without exceeding the workflow bound. */
export function discoveryPrsPerShard(candidateCount: number, shardCount: number): number {
  if (!Number.isInteger(candidateCount) || candidateCount < 1)
    throw new Error("Candidate count must be a positive integer");
  if (!Number.isInteger(shardCount) || shardCount < 1)
    throw new Error("Shard count must be a positive integer");
  return Math.max(
    DEFAULT_PRS_PER_SHARD,
    Math.ceil((candidateCount * DISCOVERY_POOL_MULTIPLIER) / shardCount),
  );
}

/** Keep every message for the same PR together; input ordering never changes membership. */
export function partitionPullRequests(
  messages: readonly ProvenanceMessage[],
  prsPerShard = DEFAULT_PRS_PER_SHARD,
): ProvenanceMessage[][] {
  if (!Number.isInteger(prsPerShard) || prsPerShard < 1)
    throw new Error("Shard size must be a positive integer");
  const byPr = new Map<number, ProvenanceMessage[]>();
  for (const message of messages) {
    if (message.sourcePr === undefined)
      throw new Error("Discovery shards require PR-associated provenance");
    const group = byPr.get(message.sourcePr) ?? [];
    group.push(message);
    byPr.set(message.sourcePr, group);
  }
  const groups = [...byPr]
    .sort(([a], [b]) => a - b)
    .map(([, group]) =>
      group.sort(
        (a, b) =>
          a.sessionId.localeCompare(b.sessionId) ||
          a.messageIndex - b.messageIndex ||
          a.content.localeCompare(b.content),
      ),
    );
  const shards: ProvenanceMessage[][] = [];
  for (let index = 0; index < groups.length; index += prsPerShard)
    shards.push(groups.slice(index, index + prsPerShard).flat());
  return shards;
}

/** Newest PR groups, packed into at most `needed` shards of `prsPerShard`. */
export function takeNewestShards(
  chunks: readonly ProvenanceMessage[][],
  needed: number,
  prsPerShard = DEFAULT_PRS_PER_SHARD,
): ProvenanceMessage[][] {
  if (!Number.isInteger(needed) || needed < 1)
    throw new Error("Shard count must be a positive integer");
  const groups: ProvenanceMessage[][] = [];
  let currentPr: number | undefined;
  for (const chunk of chunks) {
    for (const message of chunk) {
      const pr = message.sourcePr;
      if (pr === undefined) throw new Error("Discovery shards require PR-associated provenance");
      if (pr !== currentPr) {
        currentPr = pr;
        groups.push([message]);
      } else groups[groups.length - 1]?.push(message);
    }
  }
  const newest = groups.slice(Math.max(0, groups.length - needed * prsPerShard));
  const selected: ProvenanceMessage[][] = [];
  for (let index = 0; index < newest.length; index += prsPerShard)
    selected.push(newest.slice(index, index + prsPerShard).flat());
  return selected;
}
