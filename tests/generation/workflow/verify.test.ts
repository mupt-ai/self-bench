import { describe, expect, test } from "bun:test";
import {
  acceptingActivities,
  authorCandidates,
  candidate,
  draft,
  redReport,
  ref,
} from "../../support/workflow-fixture.js";

describe("SelfBench in-session verify", () => {
  test("starts each authoring round with a fresh verify budget and sequential reviews", async () => {
    const assigned = candidate("budget", 1);
    const activities = acceptingActivities([assigned]);
    const authorRounds: number[] = [];
    activities.runAuthoringRound = async ({ candidate: value, round }) => {
      authorRounds.push(round);
      return {
        kind: "submitted",
        task: draft(value.candidateId, `-r${round}`),
        session: ref(`file:///session-${round}`),
        verifyCalls: round === 1 ? 2 : 1,
      };
    };
    const verifierRounds: number[] = [];
    activities.runReviewRound = async ({ round }) => {
      verifierRounds.push(round);
      return round === 1
        ? {
            kind: "suggestions",
            session: ref("file:///v1"),
            summary: "Fix coupling",
            suggestions: "Exercise public behavior",
          }
        : { kind: "accepted", session: ref("file:///v2"), reason: "fair" };
    };
    const original = activities.compileAndVerify;
    activities.compileAndVerify = async (input) =>
      input.stage === "authoring" && input.round === 1
        ? {
            report: redReport(input.stage, input.round, input.task.taskId, { oracle: true }),
            reportRef: ref("file:///red"),
          }
        : await original(input);

    const result = await authorCandidates(activities);

    expect(result.acceptedTaskIds).toEqual(["budget-task"]);
    expect(authorRounds).toEqual([1, 2, 3]);
    expect(verifierRounds).toEqual([1, 2]);
  });
});
