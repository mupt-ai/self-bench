import { describe, expect, test } from "bun:test";
import { AUTHOR_VERIFY_BUDGET } from "../../../src/contracts/index.js";
import {
  acceptingActivities,
  authorCandidates,
  candidate,
  draft,
  redReport,
  ref,
} from "../../support/workflow-fixture.js";

describe("SelfBench verify turns", () => {
  test("each verify ends a turn and the next turn resumes with its report and draft", async () => {
    const activities = acceptingActivities([candidate("turns", 1)]);
    const turns: {
      turn: number;
      verifiesLeft: number;
      session?: string;
      draft?: string;
      report?: string;
    }[] = [];
    activities.runAuthoringTurn = async ({ candidate: value, turn, ...input }) => {
      turns.push({
        turn,
        verifiesLeft: input.verifiesLeft,
        ...(input.session ? { session: input.session.uri } : {}),
        ...(input.draft ? { draft: input.draft.definition.uri } : {}),
        ...(input.report ? { report: input.report.uri } : {}),
      });
      return {
        kind: turn < 3 ? "verify" : "submitted",
        task: draft(value.candidateId, `-t${turn}`),
        session: ref(`file:///session-t${turn}`),
      };
    };
    const checks: string[] = [];
    const original = activities.compileAndVerify;
    activities.compileAndVerify = async (input) => {
      checks.push(`${input.task.definition.uri}@${input.turn ?? "submit"}`);
      if (input.turn === undefined) return await original(input);
      return {
        report: redReport(input.stage, input.round, input.task.taskId, { oracle: true }),
        reportRef: ref(`file:///verify-t${input.turn}`),
      };
    };

    const result = await authorCandidates(activities);

    expect(result.acceptedTaskIds).toEqual(["turns-task"]);
    expect(turns).toEqual([
      { turn: 1, verifiesLeft: AUTHOR_VERIFY_BUDGET },
      {
        turn: 2,
        verifiesLeft: AUTHOR_VERIFY_BUDGET - 1,
        session: "file:///session-t1",
        draft: "file:///turns-t1/definition.json",
        report: "file:///verify-t1",
      },
      {
        turn: 3,
        verifiesLeft: AUTHOR_VERIFY_BUDGET - 2,
        session: "file:///session-t2",
        draft: "file:///turns-t2/definition.json",
        report: "file:///verify-t2",
      },
    ]);
    expect(checks).toEqual([
      "file:///turns-t1/definition.json@1",
      "file:///turns-t2/definition.json@2",
      "file:///turns-t3/definition.json@submit",
    ]);
  });

  test("never verifies past the budget and rejects a round that never submits", async () => {
    const activities = acceptingActivities([candidate("endless", 1)]);
    const turns: number[] = [];
    activities.runAuthoringTurn = async ({ candidate: value, turn }) => {
      turns.push(turn);
      return {
        kind: "verify",
        task: draft(value.candidateId, `-t${turn}`),
        session: ref(`file:///session-t${turn}`),
      };
    };
    let checks = 0;
    const original = activities.compileAndVerify;
    activities.compileAndVerify = async (input) => {
      checks += 1;
      return await original(input);
    };

    const result = await authorCandidates(activities);

    expect(result.acceptedTaskIds).toEqual([]);
    expect(turns).toEqual(Array.from({ length: AUTHOR_VERIFY_BUDGET + 1 }, (_, i) => i + 1));
    expect(checks).toBe(AUTHOR_VERIFY_BUDGET);
  });

  test("a new round starts at turn 1 with a fresh budget, the submission report, and its draft", async () => {
    const activities = acceptingActivities([candidate("rounds", 1)]);
    const starts: { round: number; turn: number; verifiesLeft: number; report?: string }[] = [];
    activities.runAuthoringTurn = async ({ candidate: value, round, turn, ...input }) => {
      starts.push({
        round,
        turn,
        verifiesLeft: input.verifiesLeft,
        ...(input.report ? { report: input.report.uri } : {}),
      });
      return {
        kind: round === 1 && turn === 1 ? "verify" : "submitted",
        task: draft(value.candidateId, `-r${round}t${turn}`),
        session: ref(`file:///session-r${round}t${turn}`),
      };
    };
    const original = activities.compileAndVerify;
    activities.compileAndVerify = async (input) =>
      input.round === 1
        ? {
            report: redReport(input.stage, input.round, input.task.taskId, { oracle: true }),
            reportRef: ref(`file:///report-r1${input.turn ? `t${input.turn}` : ""}`),
          }
        : await original(input);

    const result = await authorCandidates(activities);

    expect(result.acceptedTaskIds).toEqual(["rounds-task"]);
    expect(starts).toEqual([
      { round: 1, turn: 1, verifiesLeft: AUTHOR_VERIFY_BUDGET },
      { round: 1, turn: 2, verifiesLeft: AUTHOR_VERIFY_BUDGET - 1, report: "file:///report-r1t1" },
      { round: 2, turn: 1, verifiesLeft: AUTHOR_VERIFY_BUDGET, report: "file:///report-r1" },
    ]);
  });
});
