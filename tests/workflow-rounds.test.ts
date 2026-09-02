import { describe, expect, test } from "bun:test";
import type { RunStatus, TaskProgress } from "../src/contracts.js";
import { executeRun } from "../src/temporal/workflow.js";
import {
  acceptingActivities,
  candidate,
  draft,
  greenOutcome,
  redReport,
  ref,
  run,
} from "./support/workflow-fixture.js";

function recordStatuses(): {
  install: (status: () => RunStatus) => void;
  statuses: () => {
    status: TaskProgress["status"];
    stage: TaskProgress["stage"] | undefined;
    round: number | undefined;
  }[];
} {
  let current: (() => RunStatus) | undefined;
  return {
    install: (status) => {
      current = status;
    },
    statuses: () =>
      (current?.().tasks ?? []).map(({ status, stage, round }) => ({ status, stage, round })),
  };
}

describe("SelfBench workflow rounds", () => {
  test("accepts a task whose first authoring round is green and whose verifier accepts", async () => {
    const activities = acceptingActivities([candidate("green", 1)]);
    const calls: string[] = [];
    const wrap = <K extends "runAuthoringRound" | "compileAndVerify" | "runVerifierRound">(
      name: K,
    ): void => {
      const original = activities[name] as (input: never) => Promise<unknown>;
      (activities as Record<K, unknown>)[name] = async (input: {
        round: number;
        stage?: string;
      }) => {
        calls.push(`${name}:${input.stage ?? ""}${input.round}`);
        return await original(input as never);
      };
    };
    wrap("runAuthoringRound");
    wrap("compileAndVerify");
    wrap("runVerifierRound");
    const status = recordStatuses();

    const result = await executeRun(run, activities, status.install);

    expect(result.acceptedTaskIds).toEqual(["green-task"]);
    expect(calls).toEqual([
      "runAuthoringRound:1",
      "compileAndVerify:authoring1",
      "runVerifierRound:1",
    ]);
    expect(status.statuses()).toEqual([{ status: "accepted", stage: "verification", round: 1 }]);
  });
  test("resumes the authoring session with the report after a policy error", async () => {
    const activities = acceptingActivities([candidate("policy", 1)]);
    const rounds: { round: number; session: string | undefined; report: string | undefined }[] = [];
    activities.runAuthoringRound = async ({ candidate: value, round, session, report }) => {
      rounds.push({ round, session: session?.uri, report: report?.uri });
      return {
        kind: "submitted",
        task: draft(value.candidateId, `-r${round}`),
        session: ref(`file:///session-${round}`),
      };
    };
    activities.compileAndVerify = async ({ task, stage, round }) =>
      round === 1
        ? {
            report: redReport(stage, round, task.taskId, {
              compile: "environment variable SECRET_KEY looks like a secret",
            }),
            reportRef: ref("file:///report-1"),
          }
        : greenOutcome(task, stage, round);

    const result = await executeRun(run, activities);

    expect(result.acceptedTaskIds).toEqual(["policy-task"]);
    expect(rounds).toEqual([
      { round: 1, session: undefined, report: undefined },
      { round: 2, session: "file:///session-1", report: "file:///report-1" },
    ]);
  });
  test("rejects after three red authoring rounds with the last report as the reason", async () => {
    const activities = acceptingActivities([candidate("stubborn", 1)]);
    let authoringRounds = 0;
    const original = activities.runAuthoringRound;
    activities.runAuthoringRound = async (input) => {
      authoringRounds += 1;
      return await original(input);
    };
    activities.compileAndVerify = async ({ task, stage, round }) => ({
      report: redReport(stage, round, task.taskId, { oracle: true }),
      reportRef: ref(`file:///report-${round}`),
    });
    let verifierCalls = 0;
    activities.runVerifierRound = async () => {
      verifierCalls += 1;
      throw new Error("verifier must not run for a red task");
    };
    const status = recordStatuses();

    const result = await executeRun(run, activities, status.install);

    expect(result.acceptedTaskIds).toEqual([]);
    expect(authoringRounds).toBe(3);
    expect(verifierCalls).toBe(0);
    expect(status.statuses()).toEqual([{ status: "rejected", stage: "authoring", round: 3 }]);
  });
  test("re-verifies a verifier fix and accepts on the resumed session", async () => {
    const activities = acceptingActivities([candidate("fixable", 1)]);
    const verifierRounds: {
      round: number;
      session: string | undefined;
      report: string;
      bundle: string;
    }[] = [];
    activities.runVerifierRound = async ({ candidate: value, round, session, report, task }) => {
      verifierRounds.push({
        round,
        session: session?.uri,
        report: report.uri,
        bundle: task.bundle.uri,
      });
      if (round === 1) {
        return {
          kind: "fixed",
          task: draft(value.candidateId, "-fixed"),
          session: ref("file:///verifier-session-1"),
          summary: "rewrote assertions against the public endpoint",
        };
      }
      return { kind: "accepted", session: ref("file:///verifier-session-2"), reason: "fair" };
    };
    const verified: string[] = [];
    const original = activities.compileAndVerify;
    activities.compileAndVerify = async (input) => {
      verified.push(`${input.stage}:${input.round}:${input.task.sourceBundle.uri}`);
      return await original(input);
    };

    const result = await executeRun(run, activities);

    expect(result.acceptedTaskIds).toEqual(["fixable-task"]);
    expect(verified).toEqual([
      "authoring:1:file:///fixable/source-task.tar.gz",
      "verification:1:file:///fixable-fixed/source-task.tar.gz",
    ]);
    expect(verifierRounds).toEqual([
      {
        round: 1,
        session: undefined,
        report: "file:///fixable/authoring-round-1/report.json",
        bundle: "file:///fixable/authoring-round-1/harbor-task.tar.gz",
      },
      {
        round: 2,
        session: "file:///verifier-session-1",
        report: "file:///fixable/verification-round-1/report.json",
        bundle: "file:///fixable/verification-round-1/harbor-task.tar.gz",
      },
    ]);
  });
  test("rejects when the verifier accepts a task whose gates went red after its fix", async () => {
    const activities = acceptingActivities([candidate("red-accept", 1)]);
    activities.runVerifierRound = async ({ candidate: value, round }) =>
      round === 1
        ? {
            kind: "fixed",
            task: draft(value.candidateId, "-fixed"),
            session: ref("file:///s1"),
            summary: "changed setup",
          }
        : { kind: "accepted", session: ref("file:///s2"), reason: "looks fine" };
    activities.compileAndVerify = async ({ task, stage, round }) =>
      stage === "verification"
        ? {
            report: redReport(stage, round, task.taskId, { oracle: true }),
            reportRef: ref("file:///red"),
          }
        : greenOutcome(task, stage, round);
    const status = recordStatuses();

    const result = await executeRun(run, activities, status.install);

    expect(result.acceptedTaskIds).toEqual([]);
    expect(status.statuses()).toEqual([{ status: "rejected", stage: "verification", round: 2 }]);
  });
  test("rejects when the verifier keeps fixing for three rounds", async () => {
    const activities = acceptingActivities([candidate("looping", 1)]);
    activities.runVerifierRound = async ({ candidate: value, round }) => ({
      kind: "fixed",
      task: draft(value.candidateId, `-fix${round}`),
      session: ref(`file:///s${round}`),
      summary: `fix ${round}`,
    });
    let currentStatus: (() => RunStatus) | undefined;

    const result = await executeRun(run, activities, (status) => {
      currentStatus = status;
    });

    expect(result.acceptedTaskIds).toEqual([]);
    expect(currentStatus?.().tasks).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.stringContaining("verification exhausted 3 rounds"),
      }),
    ]);
  });
  test("rejects when the verification agent declines", async () => {
    const activities = acceptingActivities([candidate("declined", 1)]);
    activities.runVerifierRound = async ({ candidate: value }) => ({
      kind: "rejected",
      candidateId: value.candidateId,
      reason: "verification agent declined the task: no public seam",
    });
    let currentStatus: (() => RunStatus) | undefined;

    await executeRun(run, activities, (status) => {
      currentStatus = status;
    });

    expect(currentStatus?.().tasks).toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: "verification agent declined the task: no public seam",
      }),
    ]);
  });
});
