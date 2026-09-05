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
      verification: [
        entry("verification", "round-1/attempt-1/prompt.md"),
        entry("verification", "round-2/attempt-1/prompt.md"),
      ],
    },
  } as unknown as CandidateArtifacts;
  const rounds = agentRounds(artifacts);
  expect(rounds.map((round) => round.title)).toEqual([
    "Authoring Part 1",
    "Authoring Part 1",
    "Verification Part 1",
    "Verification Part 2",
  ]);
  expect(rounds[0]?.live?.key).toEndWith("00000001.json");
  expect(rounds[1]?.attempt).toBe(2);
  expect(rounds[1]?.session).toBeDefined();
});
