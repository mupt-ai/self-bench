import { describe, expect, test } from "bun:test";
import { executeRun } from "../src/temporal/workflow.js";
import {
  acceptingActivities,
  candidate,
  draft,
  redReport,
  ref,
  run,
} from "./support/workflow-fixture.js";

describe("SelfBench in-session verify", () => {
  test("skips the worker verify when the submission matches a green in-session verify", async () => {
    const activities = acceptingActivities([candidate("verified", 1)]);
    activities.runAuthoringRound = async ({ candidate: value, round }) => {
      const task = draft(value.candidateId);
      return {
        kind: "submitted",
        task,
        session: ref(`file:///session-${round}`),
        verifyCalls: 2,
        verified: {
          report: ref("file:///verified/report.json"),
          task: { ...task, bundle: ref("file:///verified/harbor-task.tar.gz") },
        },
      };
    };
    let compileCalls = 0;
    activities.compileAndVerify = async () => {
      compileCalls += 1;
      throw new Error("worker verify must be skipped");
    };
    const verifierInputs: { report: string; bundle: string }[] = [];
    activities.runVerifierRound = async ({ report, task }) => {
      verifierInputs.push({ report: report.uri, bundle: task.bundle.uri });
      return { kind: "accepted", session: ref("file:///verifier-session"), reason: "fair" };
    };

    const result = await executeRun(run, activities);

    expect(result.acceptedTaskIds).toEqual(["verified-task"]);
    expect(compileCalls).toBe(0);
    expect(verifierInputs).toEqual([
      { report: "file:///verified/report.json", bundle: "file:///verified/harbor-task.tar.gz" },
    ]);
  });
  test("starts each authoring round with a fresh verify budget", async () => {
    const activities = acceptingActivities([candidate("budget", 1)]);
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
    activities.runVerifierRound = async ({ round, session, verifyCallsUsed }) => {
      verifierRounds.push(round);
      expect(session).toBeUndefined();
      expect(verifyCallsUsed).toBeUndefined();
      if (round === 1)
        return {
          kind: "suggestions",
          session: ref("file:///v1"),
          summary: "Fix coupling",
          suggestions: "Exercise public behavior",
        };
      return { kind: "accepted", session: ref("file:///v2"), reason: "fair" };
    };
    const verified: string[] = [];
    const original = activities.compileAndVerify;
    activities.compileAndVerify = async (input) => {
      verified.push(`${input.stage}:${input.round}`);
      return input.stage === "authoring" && input.round === 1
        ? {
            report: redReport(input.stage, input.round, input.task.taskId, { oracle: true }),
            reportRef: ref("file:///red"),
          }
        : await original(input);
    };

    const result = await executeRun(run, activities);

    expect(result.acceptedTaskIds).toEqual(["budget-task"]);
    expect(authorRounds).toEqual([1, 2, 3]);
    expect(verifierRounds).toEqual([1, 2]);
    expect(verified).toEqual(["authoring:1", "authoring:2", "authoring:3"]);
  });
});
