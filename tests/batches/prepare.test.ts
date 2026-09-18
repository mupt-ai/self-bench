import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts.js";
import { prepareGenerationBatch } from "../../src/batches/prepare.js";
import { run } from "../support/workflow-fixture.js";

test("server stages complete PR chunks before dispatch, without retaining the lookup token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batch-plan-"));
  try {
    const artifacts = new LocalArtifactStore(directory);
    const provenance = await artifacts.put("input.jsonl", Buffer.alloc(0), "application/x-ndjson");
    const nodes = Array.from({ length: 26 }, (_, i) => ({
      number: i + 1,
      title: "Implement feature",
      body: "request",
      url: `https://github.com/example/repo/pull/${i + 1}`,
      isDraft: false,
      additions: 25,
      deletions: 0,
      changedFiles: 1,
      author: { login: "human", __typename: "User" },
    }));
    const batch = await prepareGenerationBatch({
      run: { ...run, provenance },
      token: "secret-lookup-token",
      taskQueue: "generation",
      artifacts,
      fetchImpl: async () =>
        Response.json({
          data: {
            repository: {
              pullRequests: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        }),
    });
    expect(batch.shards).toHaveLength(2);
    expect(batch.candidates).toEqual([]);
    expect(JSON.stringify(batch)).not.toContain("secret-lookup-token");
    const sizes = [];
    for (const shard of batch.shards) {
      expect(shard.input.partitioned).toBe(true);
      expect(shard.input.run.version).toEqual(run.version);
      const records = Buffer.from(await artifacts.get(shard.input.run.provenance))
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      sizes.push(records.length);
    }
    expect(sizes).toEqual([25, 1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
