import { afterEach, expect, spyOn, test } from "bun:test";
import { SandboxExecutionError } from "../src/sandbox/contracts.js";
import { MAILBOX_REQUESTS } from "../src/sandbox/supervisor.js";
import * as operations from "../src/sandbox/task-operation.js";
import { TaskCompilerInfrastructureError } from "../src/temporal/activities/task-compiler.js";
import { cleanupFixture, fixture, request } from "./support/session-verify-lifetime.js";

afterEach(cleanupFixture);

function transportFailure() {
  return new SandboxExecutionError("fetch failed", {
    sandboxId: "failed-preparation",
    exitCode: 1,
    stdout: "",
    stderr: "",
    outputs: {},
  });
}

for (const stage of ["unpack", "compile", "compiler-infrastructure"] as const) {
  test(`${stage} infrastructure failure aborts supervision without a false rejection report`, async () => {
    const f = await fixture();
    const failure =
      stage === "compiler-infrastructure"
        ? new TaskCompilerInfrastructureError("fetch failed")
        : transportFailure();
    if (stage === "unpack") {
      spyOn(operations, "taskOperation").mockImplementation(async (operation) => {
        if (operation === "draft") return { "/work/source-task.tar.gz": Buffer.from("draft") };
        throw failure;
      });
    } else f.compilation.mockRejectedValue(failure);
    const responses: string[] = [];
    await expect(
      f.verifier.supervise(
        {
          sandboxId: "author",
          execute: async () => ({ exitCode: 0, stdout: `${request.id}.json\n`, stderr: "" }),
          readFile: async (path) =>
            path === `${MAILBOX_REQUESTS}/${request.id}.json`
              ? Buffer.from(JSON.stringify(request))
              : undefined,
          writeFile: async (path) => {
            responses.push(path);
          },
        },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow("fetch failed");
    expect(responses).toEqual([]);
    expect(f.verifier.records).toEqual([]);
    expect(f.writes.some((key) => /report\.(json|md)$/.test(key))).toBe(false);
    expect(f.gates).not.toHaveBeenCalled();
  });
}

test("an invalid submission still receives a failed mechanical check report", async () => {
  const f = await fixture();
  spyOn(operations, "taskOperation").mockImplementation(async (operation) => {
    if (operation === "draft") return { "/work/source-task.tar.gz": Buffer.from("draft") };
    throw new Error("malformed archive");
  });
  const response = await f.verifier.handle(request, new AbortController().signal);
  expect(response.kind).toBe("report");
  if (response.kind !== "report") throw new Error("expected mechanical check report");
  expect(response.green).toBe(false);
  expect(response.summary).toContain("malformed archive");
  expect(f.verifier.records).toHaveLength(1);
  expect(f.gates).not.toHaveBeenCalled();
});
