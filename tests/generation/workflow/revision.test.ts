import { expect, test } from "bun:test";
import type { AuthoringTurnInput } from "../../../src/generation/pipeline/authoring.js";
import { authoringPrompt } from "../../../src/generation/pipeline/authoring.js";
import type { ReviewRoundInput } from "../../../src/generation/pipeline/review.js";
import { executeCandidate } from "../../../src/generation/pipeline/workflows.js";
import {
  acceptingActivities,
  candidate,
  draft,
  redReport,
  ref,
  run,
} from "../../support/workflow-fixture.js";

test("a revision restores the task's draft and hands the feedback to its first turn and reviews", async () => {
  const value = candidate("revised", 7);
  const activities = acceptingActivities([value]);
  const turns: AuthoringTurnInput[] = [];
  const reviews: ReviewRoundInput[] = [];
  const author = activities.runAuthoringTurn;
  activities.runAuthoringTurn = async (input) => {
    turns.push(input);
    return author(input);
  };
  const review = activities.runReviewRound;
  let reviewed = 0;
  activities.runReviewRound = async (input) => {
    reviews.push(input);
    reviewed += 1;
    // The first reviewer sends suggestions back, so a second round follows.
    return reviewed === 1
      ? {
          kind: "suggestions",
          summary: "Loosen one test",
          suggestions: "Accept either spelling",
          session: ref("file:///review/session.jsonl"),
        }
      : review(input);
  };
  const verify = activities.compileAndVerify;
  let verified = 0;
  activities.compileAndVerify = async (input) => {
    verified += 1;
    return verified === 1
      ? {
          report: redReport(input.stage, input.round, input.task.taskId, { oracle: true }),
          reportRef: ref("file:///red/report.json"),
        }
      : verify(input);
  };
  const original = draft("revised", "-accepted");

  const result = await executeCandidate(
    {
      run,
      candidate: value,
      revision: { draft: original, feedback: "The tests pin the error wording." },
    },
    activities,
    () => {},
  );

  expect(result.progress.status).toBe("accepted");
  expect(turns[0]).toMatchObject({
    round: 1,
    turn: 1,
    draft: original,
    maintainerFeedback: "The tests pin the error wording.",
  });
  expect(turns[0]?.session).toBeUndefined();
  // Later turns and rounds resume the agent's own session, which already read the feedback.
  expect(turns.slice(1).every((turn) => turn.maintainerFeedback === undefined)).toBe(true);
  expect(turns.length).toBeGreaterThan(1);
  expect(reviews.map((input) => input.maintainerFeedback)).toEqual([
    "The tests pin the error wording.",
    "The tests pin the error wording.",
  ]);
});

test("a new task's workflow passes no feedback", async () => {
  const value = candidate("fresh", 8);
  const activities = acceptingActivities([value]);
  const turns: AuthoringTurnInput[] = [];
  const author = activities.runAuthoringTurn;
  activities.runAuthoringTurn = async (input) => {
    turns.push(input);
    return author(input);
  };
  await executeCandidate({ run, candidate: value }, activities, () => {});
  expect(turns[0]?.draft).toBeUndefined();
  expect(turns[0]?.maintainerFeedback).toBeUndefined();
});

test("the first prompt of a revision carries the full brief and the feedback", () => {
  const prompt = authoringPrompt(
    candidate("prompt", 1),
    1,
    undefined,
    undefined,
    "The tests pin the error wording.",
  );
  expect(prompt).toContain("# Build One Eval Task");
  expect(prompt).toContain("# Maintainer Feedback");
  expect(prompt).toContain("The tests pin the error wording.");
  expect(prompt).toContain("keep its taskId");
  expect(authoringPrompt(candidate("prompt", 1), 1)).not.toContain("Maintainer Feedback");
});
