import { expect, test } from "bun:test";
import type { Context } from "@temporalio/activity";
import { activityEventInterceptor } from "../src/temporal/activity-events.js";

const context = {
  info: {
    activityType: "runAuthoringRound",
    activityId: "1",
    attempt: 2,
    workflowExecution: { workflowId: "batch-one/candidate/one", runId: "r" },
    workflowType: "selfBenchAuthorWorkflow",
  },
} as unknown as Context;

function interceptor() {
  const lines: string[] = [];
  let clock = 1_000;
  const factory = activityEventInterceptor(
    (line) => lines.push(line),
    () => (clock += 500),
  );
  const inbound = factory(context).inbound;
  if (!inbound?.execute) throw new Error("no inbound interceptor");
  const execute = inbound.execute;
  return {
    lines,
    execute: (next: () => Promise<unknown>) => execute({ args: [], headers: {} }, next),
  };
}

test("a successful activity logs only its start", async () => {
  const { lines, execute } = interceptor();
  expect(await execute(async () => "ok")).toBe("ok");
  expect(lines).toHaveLength(1);
  expect(lines[0]?.startsWith("[selfbench] ")).toBe(true);
  expect(JSON.parse(lines[0]?.slice("[selfbench] ".length) ?? "")).toEqual({
    event: "selfbench.activity",
    phase: "start",
    activityType: "runAuthoringRound",
    activityId: "1",
    workflowId: "batch-one/candidate/one",
    workflowType: "selfBenchAuthorWorkflow",
    attempt: 2,
  });
});

test("a failed activity logs the failure message and duration, then rethrows", async () => {
  const { lines, execute } = interceptor();
  const failure = new Error("authoring round 1: the model provider failed; log: gs://x");
  failure.stack = "secret stack";
  await expect(execute(async () => Promise.reject(failure))).rejects.toBe(failure);
  expect(lines).toHaveLength(2);
  const event = JSON.parse(lines[1]?.slice("[selfbench] ".length) ?? "");
  expect(event).toMatchObject({
    phase: "error",
    attempt: 2,
    durationMs: 500,
    error: "authoring round 1: the model provider failed; log: gs://x",
  });
  expect(lines[1]).not.toContain("secret stack");
});
