import { expect, test } from "bun:test";
import type { CandidateArtifacts } from "../types";
import { verifyRounds } from "./verify-rounds";

const prefix = "runs/run-1/verify/candidate";

function artifacts(keys: [string, string][]): CandidateArtifacts {
  return {
    runId: "run-1",
    taskId: "task",
    candidateId: "candidate",
    bundles: [],
    agents: [],
    groups: {
      verify: keys.map(([key, updatedAt]) => ({
        key: `${prefix}/${key}`,
        sizeBytes: 1,
        updatedAt,
      })),
    },
  } as unknown as CandidateArtifacts;
}

test("a running check shows each step's progress and its latest Harbor snapshot", () => {
  const [round] = verifyRounds(
    artifacts([
      ["authoring-round-1-turn-2/compile/attempt-1/compile.log", "2026-09-24T01:14:10Z"],
      ["authoring-round-1-turn-2/compile/attempt-1/harbor-task.tar.gz", "2026-09-24T01:14:18Z"],
      ["authoring-round-1-turn-2/live/01-nop-000003.json", "2026-09-24T01:15:00Z"],
      ["authoring-round-1-turn-2/live/01-oracle-000000.json", "2026-09-24T01:15:30Z"],
      ["authoring-round-1-turn-2/live/02-nop-000001.json", "2026-09-24T01:16:00Z"],
    ]),
  );
  expect(round?.title).toBe("Verify Part 1, Turn 2");
  expect(round?.startedAt).toBe("2026-09-24T01:14:10Z");
  // The retried attempt 2 is current; attempt 1's oracle snapshot does not count as started.
  expect(round?.live?.key).toEndWith("/live/02-nop-000001.json");
  expect(round?.report).toBeUndefined();
  expect(round?.steps.map((step) => step.state)).toEqual(["done", "running", "pending"]);
});

test("finished checks expose their report, and submissions are titled apart from turns", () => {
  const rounds = verifyRounds(
    artifacts([
      ["authoring-round-1/compile/attempt-1/harbor-task.tar.gz", "2026-09-24T02:00:00Z"],
      ["authoring-round-1/live/01-nop-000000.json", "2026-09-24T02:01:00Z"],
      ["authoring-round-1/smoke-nop.json", "2026-09-24T02:10:00Z"],
      ["authoring-round-1/live/01-oracle-000000.json", "2026-09-24T02:11:00Z"],
      ["authoring-round-1/oracle.json", "2026-09-24T02:15:00Z"],
      ["authoring-round-1/report.json", "2026-09-24T02:15:01Z"],
      ["authoring-round-1/report.md", "2026-09-24T02:15:01Z"],
      ["authoring-round-1-turn-1/compile/attempt-1/harbor-task.tar.gz", "2026-09-24T01:00:00Z"],
    ]),
  );
  expect(rounds.map((round) => round.title)).toEqual([
    "Verify Part 1, Turn 1",
    "Verify Part 1 Submission",
  ]);
  const submission = rounds[1];
  expect(submission?.report?.key).toEndWith("/report.json");
  expect(submission?.reportText?.key).toEndWith("/report.md");
  expect(submission?.live).toBeUndefined();
  expect(submission?.steps.map((step) => step.state)).toEqual(["done", "done", "done"]);
});
