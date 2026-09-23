import { expect, test } from "bun:test";
import {
  listDiscoveryShards,
  mergeDiscoveryShards,
} from "../../src/generation/runs/discovery-shards.js";

const runId = "batch-abc";
const key = (path: string) => ({ key: `runs/${runId}/discovery/${path}` });

test("lists the latest attempt per shard and prefers the newest live snapshot", () => {
  expect(
    listDiscoveryShards(
      [
        key("wave-0/shard-0/attempt-1/modal.log"),
        key("wave-0/shard-0/attempt-2/live/00000000.json"),
        key("wave-0/shard-0/attempt-2/live/00000001.json"),
        key("wave-0/shard-1/attempt-1/modal.log"),
        { key: `runs/${runId}/discovery/wave-0/shard-0/attempt-2/checkpoint.log` },
        { key: `runs/${runId}/discovery//wave-0/shard-2/attempt-1/live/00000000.json` },
      ],
      runId,
    ),
  ).toEqual([
    {
      wave: 0,
      shardIndex: 0,
      attempt: 2,
      liveKey: `runs/${runId}/discovery/wave-0/shard-0/attempt-2/live/00000001.json`,
    },
    {
      wave: 0,
      shardIndex: 1,
      attempt: 1,
      logKey: `runs/${runId}/discovery/wave-0/shard-1/attempt-1/modal.log`,
    },
    {
      wave: 0,
      shardIndex: 2,
      attempt: 1,
      liveKey: `runs/${runId}/discovery//wave-0/shard-2/attempt-1/live/00000000.json`,
    },
  ]);
});

test("keeps persisted shard errors when overlaying live artifact keys", () => {
  expect(
    mergeDiscoveryShards(
      [{ wave: 0, shardIndex: 0, error: "sandbox failed" }],
      [
        {
          wave: 0,
          shardIndex: 0,
          attempt: 2,
          liveKey: `runs/${runId}/discovery/wave-0/shard-0/attempt-2/live/00000000.json`,
        },
      ],
    ),
  ).toEqual([
    {
      wave: 0,
      shardIndex: 0,
      attempt: 2,
      liveKey: `runs/${runId}/discovery/wave-0/shard-0/attempt-2/live/00000000.json`,
      error: "sandbox failed",
    },
  ]);
});
