import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { withExecutionEnvironment } from "../src/execution-environment.js";
import * as process from "../src/process.js";
import { githubToken } from "../src/subscription-auth.js";

afterEach(() => mock.restore());

test("GitHub token lookup forwards its lifetime and rejects a late successful lookup", async () => {
  const lifetime = new AbortController();
  spyOn(process, "runCommand").mockImplementation(async (command, args, options) => {
    expect(command).toBe("gh");
    expect(args).toEqual(["auth", "token"]);
    expect(options?.signal).toBe(lifetime.signal);
    lifetime.abort(new Error("owner ended"));
    return { exitCode: 0, stdout: "mock-token", stderr: "" };
  });
  await expect(withExecutionEnvironment({}, () => githubToken(lifetime.signal))).rejects.toThrow(
    "owner ended",
  );
});

test("pre-aborted token lookup neither starts a process nor returns ambient credentials", async () => {
  const command = spyOn(process, "runCommand").mockImplementation(async () => {
    throw new Error("must not run");
  });
  await expect(
    withExecutionEnvironment({ GH_TOKEN: "mock-token" }, () =>
      githubToken(AbortSignal.abort(new Error("already ended"))),
    ),
  ).rejects.toThrow("already ended");
  expect(command).not.toHaveBeenCalled();
});
