import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts.js";
import { collectExcludedSourcePrs } from "../src/temporal/activities/excluded-source-prs.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pullRequestMessage(sourcePr: number) {
  return {
    sourceType: "github-pull-request",
    sessionId: `github:example/repo#${sourcePr}`,
    messageIndex: 0,
    content: `Change ${sourcePr}`,
    sourcePr,
    sourceUrl: `https://github.com/example/repo/pull/${sourcePr}`,
  };
}

const localMessage = {
  sourceType: "codex",
  sessionId: "session-local",
  messageIndex: 3,
  content: "Fix the flaky uploader test",
};

function discoveredCandidates(...sourcePrs: number[]) {
  return { candidates: sourcePrs.map((sourcePr) => ({ candidateId: `c${sourcePr}`, sourcePr })) };
}

async function storeWithEarlierRuns(): Promise<LocalArtifactStore> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-excluded-"));
  roots.push(root);
  const store = new LocalArtifactStore(root);
  const put = (key: string, value: unknown): Promise<unknown> =>
    store.put(key, Buffer.from(`${JSON.stringify(value)}\n`), "application/json");
  // A discovery run: checkpointed plans, a report-only shard, a failed shard gap, a second wave.
  await put("runs/discovered/discovery/wave-0/shard-0/plan.json", discoveredCandidates(7, 8));
  await put(
    "runs/discovered/discovery/wave-0/shard-0/attempt-1/report.json",
    discoveredCandidates(7, 8),
  );
  await put(
    "runs/discovered/discovery/wave-0/shard-3/attempt-2/report.json",
    discoveredCandidates(9),
  );
  await put("runs/discovered/discovery/wave-1/shard-5/plan.json", discoveredCandidates(10, 8));
  // A replay run: no discovery, only the rebuilt provenance corpus.
  await store.put(
    "runs/replayed/provenance/replay.jsonl",
    Buffer.from(
      `${[pullRequestMessage(11), localMessage].map((message) => JSON.stringify(message)).join("\n")}\n`,
    ),
    "application/x-ndjson",
  );
  // An archived status whose candidates resolve through provenance or the authored definition.
  await put("runs/archived/status.json", {
    runId: "archived",
    phase: "complete",
    tasks: [
      { taskId: "t12", candidateId: "w0s1-twelve", difficulty: "easy", status: "rejected" },
      { taskId: "t13", candidateId: "w0s2-thirteen", difficulty: "hard", status: "accepted" },
    ],
  });
  await put("runs/archived/provenance/w0s1-twelve.json", {
    source: pullRequestMessage(12),
    messages: [],
  });
  await put("runs/archived/provenance/w0s2-thirteen.json", {
    source: localMessage,
    messages: [],
  });
  await put("runs/archived/authoring/w0s2-thirteen/round-1/definition.json", {
    difficulty: "hard",
    sourcePr: 13,
    sourceUrl: "https://github.com/example/repo/pull/13",
  });
  return store;
}

describe("collectExcludedSourcePrs", () => {
  test("reads every processed pull request from discovery plans and reports", async () => {
    const store = await storeWithEarlierRuns();

    expect(await collectExcludedSourcePrs(store, ["discovered"])).toEqual([7, 8, 9, 10]);
  });

  test("reads a replay run's pull requests from its rebuilt provenance", async () => {
    const store = await storeWithEarlierRuns();

    expect(await collectExcludedSourcePrs(store, ["replayed"])).toEqual([11]);
  });

  test("resolves archived status candidates through provenance and definitions", async () => {
    const store = await storeWithEarlierRuns();

    expect(await collectExcludedSourcePrs(store, ["archived"])).toEqual([12, 13]);
  });

  test("unions and sorts pull requests across runs, ignoring repeated run IDs", async () => {
    const store = await storeWithEarlierRuns();

    expect(
      await collectExcludedSourcePrs(store, ["archived", "discovered", "replayed", "archived"]),
    ).toEqual([7, 8, 9, 10, 11, 12, 13]);
  });

  test("fails non-retryably for a run without any candidate records", async () => {
    const store = await storeWithEarlierRuns();

    await expect(collectExcludedSourcePrs(store, ["discovered", "missing"])).rejects.toMatchObject({
      type: "ExcludedRunMissing",
      nonRetryable: true,
      message: expect.stringContaining("missing"),
    });
  });

  test("fails when an archived candidate has no resolvable pull request", async () => {
    const store = await storeWithEarlierRuns();
    await store.put(
      "runs/partial/status.json",
      Buffer.from(JSON.stringify({ tasks: [{ candidateId: "w0s0-orphan" }] })),
      "application/json",
    );
    await store.put(
      "runs/partial/provenance/w0s0-orphan.json",
      Buffer.from(JSON.stringify({ source: localMessage, messages: [] })),
      "application/json",
    );

    await expect(collectExcludedSourcePrs(store, ["partial"])).rejects.toMatchObject({
      type: "ExcludedRunMissing",
      message: expect.stringContaining("w0s0-orphan"),
    });
  });
});
