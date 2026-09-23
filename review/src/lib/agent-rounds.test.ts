import { expect, test } from "bun:test";
import type { CandidateArtifacts } from "../types";
import { agentRounds } from "./agent-rounds";

test("groups native snapshots into numbered parts and distinct retries", () => {
  const entry = (stage: string, suffix: string) => ({
    key: `runs/run-123/${stage}/candidate/${suffix}`,
    sizeBytes: 10,
  });
  const artifacts = {
    runId: "run-123",
    taskId: "task",
    candidateId: "candidate",
    bundles: [],
    groups: {
      authoring: [
        entry("authoring", "round-1/attempt-1/live/00000000.json"),
        entry("authoring", "round-1/attempt-1/live/00000001.json"),
        entry("authoring", "round-1/attempt-2/prompt.md"),
        entry("authoring", "session/round-1-attempt-2.jsonl"),
      ],
      review: [
        entry("review", "round-1/attempt-1/prompt.md"),
        entry("review", "round-2/attempt-1/prompt.md"),
      ],
    },
  } as unknown as CandidateArtifacts;
  const rounds = agentRounds(artifacts);
  expect(rounds.map((round) => round.title)).toEqual([
    "Authoring Part 1",
    "Authoring Part 1",
    "Review Part 1",
    "Review Part 2",
  ]);
  expect(rounds[0]?.live?.key).toEndWith("00000001.json");
  expect(rounds[1]?.attempt).toBe(2);
  expect(rounds[1]?.session).toBeDefined();
  expect(rounds[1]?.status).toBeUndefined();
});

test("marks retries before a round result as failed", () => {
  const entry = (stage: string, suffix: string) => ({
    key: `runs/run-123/${stage}/candidate/${suffix}`,
    sizeBytes: 10,
  });
  const artifacts = {
    runId: "run-123",
    taskId: "task",
    candidateId: "candidate",
    bundles: [],
    groups: {
      authoring: [],
      review: [
        entry("review", "round-1/attempt-1/prompt.md"),
        entry("review", "session/round-1-attempt-1.jsonl"),
        entry("review", "round-1/attempt-2/prompt.md"),
        entry("review", "session/round-1-attempt-2.jsonl"),
        entry("review", "round-1/result.json"),
      ],
    },
  } as unknown as CandidateArtifacts;

  const rounds = agentRounds(artifacts);
  expect(rounds.filter((round) => round.stage === "review").map((round) => round.status)).toEqual([
    "failed",
    "finished",
  ]);
});

test("lists recorded agent runs in start order with turns, retries, and outcomes", () => {
  const prefix = "runs/run-123/authoring/candidate";
  const entry = (suffix: string) => ({ key: `${prefix}/${suffix}`, sizeBytes: 10 });
  const record = (turn: number, attempt: number, startedAt: string, extra = {}) => ({
    stage: "authoring" as const,
    round: 1,
    turn,
    attempt,
    prefix: `${prefix}/round-1/turn-${turn}/attempt-${attempt}`,
    session: `${prefix}/session/round-1-turn-${turn}.jsonl`,
    startedAt,
    ...extra,
  });
  const artifacts = {
    runId: "run-123",
    taskId: "task",
    candidateId: "candidate",
    bundles: [],
    groups: {
      authoring: [
        entry("round-1/turn-1/attempt-1/live/00000000.json"),
        entry("round-1/turn-1/attempt-1/live/00000001.json"),
        entry("session/round-1-turn-1.jsonl"),
      ],
      review: [],
    },
    agents: [
      record(2, 2, "2026-09-23T10:20:00Z"),
      record(1, 1, "2026-09-23T10:00:00Z", { finishedAt: "2026-09-23T10:05:00Z", exitCode: 0 }),
      record(2, 1, "2026-09-23T10:10:00Z", { finishedAt: "2026-09-23T10:15:00Z", exitCode: 0 }),
    ],
  } as unknown as CandidateArtifacts;

  const rounds = agentRounds(artifacts);

  expect(rounds.map((round) => [round.title, round.attempt, round.status])).toEqual([
    ["Authoring Part 1, Turn 1", 1, "finished"],
    ["Authoring Part 1, Turn 2", 1, "failed"],
    ["Authoring Part 1, Turn 2", 2, undefined],
  ]);
  expect(rounds[0]?.live?.key).toEndWith("00000001.json");
  expect(rounds[0]?.session?.key).toEndWith("round-1-turn-1.jsonl");
  expect(rounds[2]?.session).toBeUndefined();
});
