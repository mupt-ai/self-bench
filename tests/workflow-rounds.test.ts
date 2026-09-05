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
  test("sends suggestions to the next author, rechecks its draft, and uses a fresh reviewer", async () => {
    const activities = acceptingActivities([candidate("fixable", 1)]);
    const calls: string[] = [];
    const author = activities.runAuthoringRound;
    activities.runAuthoringRound = async (input) => {
      calls.push(`author:${input.round}`);
      if (input.round === 2) {
        expect(input.feedback).toBe(
          "Fairness issue\n\nTest the public endpoint, not private helpers",
        );
        expect(input.session).toBeDefined();
        expect(input.report).toBeDefined();
      }
      return author(input);
    };
    const compile = activities.compileAndVerify;
    activities.compileAndVerify = async (input) => {
      calls.push(`checks:${input.round}`);
      expect(input.stage).toBe("authoring");
      return compile(input);
    };
    activities.runVerifierRound = async (input) => {
      calls.push(`review:${input.round}`);
      expect(input.session).toBeUndefined();
      return input.round === 1
        ? {
            kind: "suggestions",
            session: ref("file:///v1"),
            summary: "Fairness issue",
            suggestions: "Test the public endpoint, not private helpers",
          }
        : { kind: "accepted", session: ref("file:///v2"), reason: "fair" };
    };
    const result = await executeRun(run, activities);
    expect(result.acceptedTaskIds).toEqual(["fixable-task"]);
    expect(calls).toEqual(["author:1", "checks:1", "review:1", "author:2", "checks:2", "review:2"]);
  });
  test("never reviews a revised draft while mechanical checks are red", async () => {
    const activities = acceptingActivities([candidate("red-revision", 1)]);
    const reviews: number[] = [];
    activities.runVerifierRound = async ({ round }) => {
      reviews.push(round);
      return {
        kind: "suggestions",
        session: ref("file:///v1"),
        summary: "Fix tests",
        suggestions: "Use public seams",
      };
    };
    activities.compileAndVerify = async ({ task, stage, round }) =>
      round === 1
        ? greenOutcome(task, stage, round)
        : {
            report: redReport(stage, round, task.taskId, { oracle: true }),
            reportRef: ref("file:///red"),
          };
    const result = await executeRun(run, activities);
    expect(result.acceptedTaskIds).toEqual([]);
    expect(reviews).toEqual([1]);
  });
  test("bounds authoring revisions when reviewers keep requesting changes", async () => {
    const activities = acceptingActivities([candidate("looping", 1)]);
    const authors: number[] = [];
    const author = activities.runAuthoringRound;
    activities.runAuthoringRound = async (input) => {
      authors.push(input.round);
      return author(input);
    };
    activities.runVerifierRound = async ({ round }) => ({
      kind: "suggestions",
      session: ref(`file:///v${round}`),
      summary: "Still coupled",
      suggestions: "Use a public seam",
    });
    let current: (() => RunStatus) | undefined;
    const result = await executeRun(run, activities, (status) => {
      current = status;
    });
    expect(result.acceptedTaskIds).toEqual([]);
    expect(authors).toEqual([1, 2, 3]);
    expect(current?.().tasks[0]?.reason).toContain("authoring exhausted 3 rounds");
    expect(current?.().tasks[0]?.reason).toContain("Use a public seam");
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
