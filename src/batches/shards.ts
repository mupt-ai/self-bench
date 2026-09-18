import type { ProvenanceMessage } from "../provenance/types.js";

/** Keep every message for the same PR together; input ordering never changes membership. */
export function partitionPullRequests(
  messages: readonly ProvenanceMessage[],
  prsPerShard = 25,
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
