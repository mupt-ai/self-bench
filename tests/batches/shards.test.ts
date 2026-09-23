import { expect, test } from "bun:test";
import {
  discoveryPrsPerShard,
  partitionPullRequests,
  takeNewestShards,
} from "../../src/generation/batches/shards.js";
import type { ProvenanceMessage } from "../../src/third_party/github/provenance.js";

function message(pr: number, index = 0): ProvenanceMessage {
  return {
    sourceType: "github-pull-request",
    sessionId: `pr-${pr}`,
    messageIndex: index,
    content: `PR ${pr}`,
    sourcePr: pr,
    sourceUrl: `https://github.com/o/r/pull/${pr}`,
  };
}
test("deterministic nonempty chunks keep all PR provenance together", () => {
  const input = Array.from({ length: 51 }, (_, i) => message(i + 1));
  input.push(message(26, 1));
  const chunks = partitionPullRequests(input);
  expect(chunks.map((chunk) => new Set(chunk.map((item) => item.sourcePr)).size)).toEqual([
    25, 25, 1,
  ]);
  expect(chunks[1]?.filter((item) => item.sourcePr === 26)).toHaveLength(2);
  expect(partitionPullRequests([...input].reverse())).toEqual(chunks);
  expect(partitionPullRequests([])).toEqual([]);
  expect(partitionPullRequests([message(1)])).toHaveLength(1);
  expect(() => partitionPullRequests(input, 0)).toThrow();
});

test("newest shards keep a full window of the highest PR numbers", () => {
  const chunks = partitionPullRequests(Array.from({ length: 51 }, (_, i) => message(i + 1)));
  const newest = takeNewestShards(chunks, 1);
  expect(newest).toHaveLength(1);
  expect(new Set(newest[0]?.map((item) => item.sourcePr))).toEqual(
    new Set(Array.from({ length: 25 }, (_, i) => i + 27)),
  );
  expect(takeNewestShards(chunks, 3)).toHaveLength(3);
  expect(() => takeNewestShards(chunks, 0)).toThrow();
});

test("large requests widen bounded shards to cover the discovery pool", () => {
  const messages = Array.from({ length: 500 }, (_, i) => message(i + 1));
  const chunks = partitionPullRequests(messages);
  const prsPerShard = discoveryPrsPerShard(300, 8);
  const selected = takeNewestShards(chunks, 8, prsPerShard);
  const sourcePrs = new Set(
    selected.flatMap((chunk) =>
      chunk.flatMap((item) => (item.sourcePr === undefined ? [] : [item.sourcePr])),
    ),
  );

  expect(prsPerShard).toBe(57);
  expect(selected).toHaveLength(8);
  expect(sourcePrs.size).toBe(456);
  expect(Math.min(...sourcePrs)).toBe(45);
  expect(Math.max(...sourcePrs)).toBe(500);
  expect(() => discoveryPrsPerShard(0, 8)).toThrow();
  expect(() => discoveryPrsPerShard(1, 0)).toThrow();
});
