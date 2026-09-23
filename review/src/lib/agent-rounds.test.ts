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

test("splits authoring rounds into turns, one per verify", () => {
  const entry = (suffix: string) => ({
    key: `runs/run-123/authoring/candidate/${suffix}`,
    sizeBytes: 10,
  });
  const artifacts = {
    runId: "run-123",
    taskId: "task",
    candidateId: "candidate",
    bundles: [],
    groups: {
      authoring: [
        entry("round-1/result.json"),
        entry("round-1/turn-1/attempt-1/live/00000000.json"),
        entry("session/round-1-turn-1.jsonl"),
        entry("round-1/turn-1/result.json"),
        entry("round-1/turn-2/attempt-1/prompt.md"),
        entry("round-1/turn-2/attempt-2/prompt.md"),
        entry("session/round-1-turn-2-attempt-2.jsonl"),
        entry("round-1/turn-2/result.json"),
      ],
    },
  } as unknown as CandidateArtifacts;

  const rounds = agentRounds(artifacts);
  expect(rounds.map((round) => [round.title, round.attempt, round.status])).toEqual([
    ["Authoring Part 1, Turn 1", 1, "finished"],
    ["Authoring Part 1, Turn 2", 1, "failed"],
    ["Authoring Part 1, Turn 2", 2, "finished"],
  ]);
  expect(rounds[0]?.live?.key).toEndWith("00000000.json");
  expect(rounds[2]?.session?.key).toEndWith("round-1-turn-2-attempt-2.jsonl");
});
