import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts.js";
import type { Candidate, RunStatus } from "../src/contracts.js";
import {
  rebuildReplayCandidate,
  rebuildReplayCandidates,
} from "../src/temporal/activities/replay.js";
import { executeRun } from "../src/temporal/workflow.js";
import { acceptingActivities, artifact, candidate, run } from "./support/workflow-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const services = {
  resolveCompletedCommit: async (repository: string, pullRequest: number) =>
    `${repository}#${pullRequest}`.length > 0 ? "e".repeat(40) : "",
  resolveRepositoryHead: async () => "f".repeat(40),
};

const provenanceMessage = {
  sourceType: "github-pull-request",
  sessionId: "github:example/repo#7",
  messageIndex: 0,
  content: "Add retry handling to the uploader",
  sourcePr: 7,
  sourceUrl: "https://github.com/example/repo/pull/7",
};

async function storeWithSourceRun(): Promise<LocalArtifactStore> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-replay-"));
  roots.push(root);
  const store = new LocalArtifactStore(root);
  const put = (key: string, value: unknown): Promise<unknown> =>
    store.put(key, Buffer.from(`${JSON.stringify(value)}\n`), "application/json");
  await put("runs/source/provenance/w0s2-uploader.json", {
    source: provenanceMessage,
    messages: [{ role: "user", content: provenanceMessage.content }],
  });
  await put("runs/source/provenance/w1s0-legacy.json", {
    source: {
      ...provenanceMessage,
      sessionId: "github:example/repo#8",
      sourcePr: 8,
      sourceUrl: "https://github.com/example/repo/pull/8",
    },
    messages: [],
  });
  const discovered: Candidate = {
    candidateId: "w0s2-uploader",
    difficulty: "medium",
    sourcePr: 7,
    sourceUrl: "https://github.com/example/repo/pull/7",
    baseCommit: "a".repeat(40),
    completedCommit: "b".repeat(40),
    request: provenanceMessage.content,
    provenance: artifact,
  };
  await put("runs/source/discovery/wave-0/shard-2/attempt-2/report.json", {
    candidates: [discovered],
    logs: artifact,
  });
  await put("runs/source/authoring/w1s0-legacy/definition.json", {
    schemaVersion: 2,
    difficulty: "hard",
    taskId: "legacy-task",
    repo: "example/repo",
    baseCommit: "C".repeat(40),
    sourcePr: 8,
    sourceUrl: "https://github.com/example/repo/pull/8",
  });
  return store;
}

describe("replay candidate reconstruction", () => {
  test("prefers the discovery report candidate located from the id prefix", async () => {
    const store = await storeWithSourceRun();

    const rebuilt = await rebuildReplayCandidate(store, "source", "w0s2-uploader", services);

    expect(rebuilt.candidate).toEqual({
      candidateId: "w0s2-uploader",
      difficulty: "medium",
      sourcePr: 7,
      sourceUrl: "https://github.com/example/repo/pull/7",
      baseCommit: "a".repeat(40),
      completedCommit: "b".repeat(40),
      request: provenanceMessage.content,
      provenance: expect.objectContaining({ contentType: "application/json" }),
    });
    expect(Buffer.from(await store.get(rebuilt.candidate.provenance)).toString("utf8")).toContain(
      "Add retry handling",
    );
  });

  test("falls back to the authored definition and resolves the completed commit", async () => {
    const store = await storeWithSourceRun();

    const rebuilt = await rebuildReplayCandidate(store, "source", "w1s0-legacy", services);

    expect(rebuilt.candidate).toEqual(
      expect.objectContaining({
        candidateId: "w1s0-legacy",
        difficulty: "hard",
        sourcePr: 8,
        baseCommit: "c".repeat(40),
        completedCommit: "e".repeat(40),
      }),
    );
  });

  test("fails when the candidate has no provenance or no source record", async () => {
    const store = await storeWithSourceRun();

    await expect(rebuildReplayCandidate(store, "source", "w9s9-missing", services)).rejects.toThrow(
      "has no provenance artifact",
    );
    await store.put(
      "runs/source/provenance/w9s9-orphan.json",
      Buffer.from(JSON.stringify({ source: provenanceMessage, messages: [] })),
      "application/json",
    );
    await expect(rebuildReplayCandidate(store, "source", "w9s9-orphan", services)).rejects.toThrow(
      "neither a discovery report nor an authored definition",
    );
  });

  test("rebuilds the run material with repository and provenance artifacts", async () => {
    const store = await storeWithSourceRun();

    const material = await rebuildReplayCandidates(
      store,
      {
        runId: "replay",
        replay: { sourceRunId: "source", candidateIds: ["w0s2-uploader", "w1s0-legacy"] },
        authoring: run.authoring,
        version: run.version,
      },
      services,
    );

    expect(material.candidates.map((value) => value.candidateId)).toEqual([
      "w0s2-uploader",
      "w1s0-legacy",
    ]);
    expect(material.repository).toEqual({
      url: "https://github.com/example/repo.git",
      commit: "f".repeat(40),
    });
    const lines = Buffer.from(await store.get(material.provenance))
      .toString("utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
  });
});

describe("replay workflow", () => {
  test("skips discovery and processes the rebuilt candidates", async () => {
    const activities = acceptingActivities([]);
    let discoveryCalls = 0;
    activities.discoverCandidateShard = async () => {
      discoveryCalls += 1;
      return { candidates: [], report: artifact };
    };
    activities.rebuildReplayCandidates = async (input) => ({
      candidates: input.replay.candidateIds.map((id, index) => candidate(id, index + 1, "medium")),
      repository: run.repository,
      provenance: artifact,
    });
    let currentStatus: (() => RunStatus) | undefined;

    const result = await executeRun(
      {
        runId: "replay",
        replay: { sourceRunId: "source", candidateIds: ["w0s2-uploader", "w1s0-legacy"] },
        authoring: run.authoring,
        version: run.version,
      },
      activities,
      (status) => {
        currentStatus = status;
      },
    );

    expect(discoveryCalls).toBe(0);
    expect(result.acceptedTaskIds).toEqual(["w0s2-uploader-task", "w1s0-legacy-task"]);
    expect(currentStatus?.().requested).toBe(2);
    expect(currentStatus?.().requestedByDifficulty).toEqual({ easy: 0, medium: 2, hard: 0 });
    expect(currentStatus?.().phase).toBe("complete");
  });
});
