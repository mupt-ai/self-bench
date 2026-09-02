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
    const budgets: number[] = [];
    activities.runAuthoringRound = async ({ candidate: value, round, verifyCallsUsed }) => {
      budgets.push(verifyCallsUsed ?? -1);
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
    expect(budgets).toEqual([0]);
    expect(verifierInputs).toEqual([
      { report: "file:///verified/report.json", bundle: "file:///verified/harbor-task.tar.gz" },
    ]);
  });
  test("carries spent verify calls into the fallback round and reuses a verified fix", async () => {
    const activities = acceptingActivities([candidate("budget", 1)]);
    const authorBudgets: number[] = [];
    activities.runAuthoringRound = async ({ candidate: value, round, verifyCallsUsed }) => {
      authorBudgets.push(verifyCallsUsed ?? -1);
      return {
        kind: "submitted",
        task: draft(value.candidateId, `-r${round}`),
        session: ref(`file:///session-${round}`),
        verifyCalls: round === 1 ? 2 : 1,
      };
    };
    const verifierBudgets: number[] = [];
    activities.runVerifierRound = async ({ candidate: value, round, verifyCallsUsed }) => {
      verifierBudgets.push(verifyCallsUsed ?? -1);
      if (round === 1) {
        const task = draft(value.candidateId, "-fixed");
        return {
          kind: "fixed",
          task,
          session: ref("file:///v1"),
          summary: "fixed",
          verifyCalls: 1,
          verified: {
            report: ref("file:///fix-report"),
            task: { ...task, bundle: ref("file:///fix-bundle") },
          },
        };
      }
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
    expect(authorBudgets).toEqual([0, 2]);
    expect(verifierBudgets).toEqual([0, 1]);
    expect(verified).toEqual(["authoring:1", "authoring:2"]);
  });
});
