import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { MAX_DISCOVERY_SHARDS } from "../../src/contracts/config/execution-limits.js";
import { prepareGenerationBatch } from "../../src/generation/batches/prepare.js";
import { run } from "../support/workflow-fixture.js";

test("caps independent discovery while covering enough PRs for a max-size run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "batch-shard-cap-"));
  try {
    const artifacts = new LocalArtifactStore(directory);
    const provenance = await artifacts.put("input.jsonl", Buffer.alloc(0), "application/x-ndjson");
    const nodes = Array.from({ length: 500 }, (_, i) => ({
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
      run: {
        ...run,
        provenance,
        candidateCounts: { easy: 0, medium: 0, hard: 300 },
      },
      token: "secret-lookup-token",
      taskQueue: "generation",
      attempt: 1,
      artifacts,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as { variables: { after: string | null } };
        const start = body.variables.after ? Number(body.variables.after) : 0;
        const pageNodes = nodes.slice(start, start + 100);
        const end = start + pageNodes.length;
        return Response.json({
          data: {
            repository: {
              pullRequests: {
                nodes: pageNodes,
                pageInfo: {
                  hasNextPage: end < nodes.length,
                  endCursor: end < nodes.length ? String(end) : null,
                },
              },
            },
          },
        });
      },
    });
    expect(batch.shards).toHaveLength(MAX_DISCOVERY_SHARDS);
    expect(batch.shards.every((shard) => shard.input.shardCount === MAX_DISCOVERY_SHARDS)).toBe(
      true,
    );
    const sourcePrs = new Set<number>();
    for (const shard of batch.shards) {
      const records = Buffer.from(await artifacts.get(shard.input.run.provenance))
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { sourcePr: number });
      for (const record of records) sourcePrs.add(record.sourcePr);
    }
    expect(sourcePrs.size).toBeGreaterThanOrEqual(300);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
      attempt: 1,
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
    expect(batch.shards).toHaveLength(1);
    expect(batch.shards[0]?.input.shardCount).toBe(1);
    expect(batch.shards[0]?.input.targetCounts).toEqual({ easy: 0, medium: 0, hard: 1 });
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
    expect(sizes).toEqual([25]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
