import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as submission from "../src/sandbox/submission.js";
import { readSubmission } from "../src/temporal/activities/submissions.js";

afterEach(() => mock.restore());
test("remote unpack outage propagates instead of masquerading as a malformed submission", async () => {
  const error = new Error("provider unavailable");
  spyOn(submission, "submissionPatches").mockRejectedValue(error);
  await expect(readSubmission(Buffer.from('{"taskId":"one"}'), Buffer.from("bundle"))).rejects.toBe(
    error,
  );
});
test("submission forwards cancellation and refuses late remote output", async () => {
  const controller = new AbortController();
  const error = new Error("cancelled");
  const spy = spyOn(submission, "submissionPatches").mockImplementation(async (_bundle, signal) => {
    expect(signal).toBe(controller.signal);
    controller.abort(error);
    return { testPatch: "test", goldPatch: "gold" };
  });
  await expect(
    readSubmission(Buffer.from("{}"), Buffer.from("bundle"), controller.signal),
  ).rejects.toBe(error);
  expect(spy).toHaveBeenCalledTimes(1);
});
test("malformed definition remains a local validation failure without allocating", async () => {
  const spy = spyOn(submission, "submissionPatches");
  expect(await readSubmission(Buffer.from("{"), Buffer.from("bundle"))).toBeUndefined();
  expect(spy).not.toHaveBeenCalled();
});
