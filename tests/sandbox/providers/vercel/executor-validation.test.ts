import { describe, expect, test } from "bun:test";
import { VercelSandboxExecutor } from "../../../../src/sandbox/providers/vercel/executor.js";
import {
  vercelFixtureConfig as config,
  VercelSdkFixture,
} from "../../../support/vercel-sdk-fixture.js";

describe("VercelSandboxExecutor validation", () => {
  test("deletes a sandbox when bounded post-stream completion fails", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandStatusFails = true;
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    await expect(
      executor.run({
        runId: "poll-failure",
        stage: "author",
        command: ["true"],
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("simulated command status failure");
    expect(fixture.calls.at(-1)?.method).toBe("DELETE");
    expect(
      fixture.calls.find((call) => call.method === "GET" && call.path.includes("/cmd/cmd_test?"))
        ?.path,
    ).toContain("wait=true");
  });
  test("treats a missing required output after exit zero as an execution failure", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandExitCode = 0;
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    await expect(
      executor.run({
        runId: "missing-output",
        stage: "author",
        command: ["node", "script.js"],
        outputPaths: ["/work/required.tar.gz"],
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("exited successfully without output /work/required.tar.gz");
    expect(fixture.calls.at(-1)?.method).toBe("DELETE");
  });
  test("rejects invalid paths and resource mappings before allocation", async () => {
    const fixture = new VercelSdkFixture();
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    await expect(
      executor.run({
        runId: "invalid",
        stage: "path",
        command: ["true"],
        files: [{ path: "/work/../secret", contents: "no" }],
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("sandbox path must be beneath /work");
    await expect(
      executor.run({
        runId: "invalid",
        stage: "memory",
        command: ["true"],
        timeoutMs: 60_000,
        cpu: 4,
        memoryMiB: 4096,
      }),
    ).rejects.toThrow("Vercel fixes memory at 2048 MiB per vCPU");
    expect(fixture.calls).toEqual([]);
  });
  test("rejects a created sandbox whose session is not running", async () => {
    const fixture = new VercelSdkFixture();
    fixture.sessionStatus = "stopped";
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    await expect(
      executor.run({
        runId: "invalid-session-status",
        stage: "author",
        command: ["true"],
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("created in unexpected state stopped");
    expect(fixture.calls.at(-1)?.method).toBe("DELETE");
  });
  test("rejects a created sandbox whose image workdir is not /work", async () => {
    const fixture = new VercelSdkFixture();
    fixture.sessionCwd = "/vercel";
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    await expect(
      executor.run({
        runId: "invalid-session-cwd",
        stage: "author",
        command: ["true"],
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("has workdir /vercel; expected /work");
    expect(fixture.calls.at(-1)?.method).toBe("DELETE");
  });
  test("rejects a created sandbox whose resources differ from the request", async () => {
    const fixture = new VercelSdkFixture();
    fixture.sessionMemory = 4096;
    fixture.sessionVcpus = 2;
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    await expect(
      executor.run({
        runId: "invalid-session-resources",
        stage: "author",
        command: ["true"],
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("returned 2 vCPU/4096 MiB; expected 4 vCPU/8192 MiB");
    expect(fixture.calls.at(-1)?.method).toBe("DELETE");
  });
  test("does not allocate when cancellation is already requested", async () => {
    const fixture = new VercelSdkFixture();
    const executor = new VercelSandboxExecutor(config, fixture.fetch);
    const controller = new AbortController();
    controller.abort(new Error("cancelled before run"));

    await expect(
      executor.run(
        { runId: "cancelled", stage: "author", command: ["true"], timeoutMs: 60_000 },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled before run");
    expect(fixture.calls).toEqual([]);
  });
});
