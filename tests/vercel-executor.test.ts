import { describe, expect, test } from "bun:test";
import { InactivityTimeoutError } from "../src/process.js";
import { VercelSandboxExecutor } from "../src/vercel-executor.js";
import {
  vercelFixtureConfig as config,
  vercelFixtureImage as image,
  vercelRequestBody as requestBody,
  VercelSdkFixture,
} from "./support/vercel-sdk-fixture.js";

describe("VercelSandboxExecutor", () => {
  test("constructs and closes without making an eager SDK request", () => {
    const fixture = new VercelSdkFixture();
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    executor.close();

    expect(fixture.calls).toEqual([]);
  });

  test("runs through the pinned SDK with isolated creation, exact inputs, streams, and cleanup", async () => {
    const fixture = new VercelSdkFixture();
    fixture.outputs.set("/work/result.bin", Uint8Array.from([0, 255, 1, 2]));
    fixture.outputs.set("/work/empty.bin", new Uint8Array());
    const executor = new VercelSandboxExecutor(config, fixture.fetch);
    const progress: Array<{ stream: "stdout" | "stderr"; bytes: number }> = [];
    const backing = Uint8Array.from([9, 0, 1, 2, 8]);

    const result = await executor.run(
      {
        runId: "run.with.dots",
        stage: `${"stage.with.dots".repeat(20)}-end`,
        command: ["node", "script.js", "space value", "semi;colon", "$dollar", ""],
        files: [
          { path: "/work/nested/input.bin", contents: backing.subarray(1, 4) },
          { path: "/work/empty.txt", contents: "" },
          { path: "/work/unicode.txt", contents: "héllo 🌍" },
          { path: "/work/overwrite.txt", contents: "first" },
          { path: "/work/overwrite.txt", contents: "second" },
        ],
        outputPaths: ["/work/result.bin", "/work/empty.bin", "/work/missing-after-nonzero"],
        environment: { SHARED: "ordinary", EMPTY: "" },
        secrets: { SHARED: "secret", API_KEY: "workload-only" },
        timeoutMs: 60_000,
        inactivityTimeoutMs: 10_000,
        cpu: 4,
        memoryMiB: 8192,
      },
      { onProgress: (event) => progress.push(event) },
    );

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("hello world\n");
    expect(result.stderr).toBe("warning\n");
    expect(result.outputs["/work/result.bin"]).toEqual(Uint8Array.from([0, 255, 1, 2]));
    expect(result.outputs["/work/empty.bin"]).toEqual(new Uint8Array());
    expect(result.outputs["/work/missing-after-nonzero"]).toBeUndefined();
    expect(progress).toEqual([
      { stream: "stdout", bytes: 6 },
      { stream: "stderr", bytes: 8 },
      { stream: "stdout", bytes: 6 },
    ]);
    expect(fixture.uploadedFiles.get("work/nested/input.bin")).toEqual(Uint8Array.from([0, 1, 2]));
    expect(fixture.uploadedFiles.get("work/empty.txt")).toEqual(new Uint8Array());
    expect(Buffer.from(fixture.uploadedFiles.get("work/unicode.txt") ?? []).toString("utf8")).toBe(
      "héllo 🌍",
    );
    expect(
      Buffer.from(fixture.uploadedFiles.get("work/overwrite.txt") ?? []).toString("utf8"),
    ).toBe("second");

    const create = requestBody(fixture.calls, "POST", "/api/v3/sandboxes");
    expect(create.projectId).toBe("prj_test");
    expect(create.image).toBe(image);
    expect(create.persistent).toBe(false);
    expect(create.resources).toEqual({ vcpus: 4 });
    expect(create.timeout).toBe(60_000);
    expect(create.env).toBeUndefined();
    expect(create.name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(String(create.name).length).toBeLessThanOrEqual(128);
    expect(create.tags).toEqual({
      selfbench_run: "run.with.dots",
      selfbench_stage: `${"stage.with.dots".repeat(20)}-end`.slice(0, 256),
    });

    const command = requestBody(fixture.calls, "POST", "/cmd");
    expect(command.command).toBe("node");
    expect(command.args).toEqual(["script.js", "space value", "semi;colon", "$dollar", ""]);
    expect(command.cwd).toBe("/work");
    expect(command.env).toEqual({
      SHARED: "secret",
      EMPTY: "",
      API_KEY: "workload-only",
    });
    expect(JSON.stringify(command)).not.toContain(config.credentials.token);
    expect(fixture.calls.at(-1)?.method).toBe("DELETE");
    expect(fixture.calls.every((call) => call.authorization === "Bearer vcp_test_token")).toBe(
      true,
    );
  });

  test("suppresses the SDK retry that could start a command twice", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandStartStatus = 503;
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    const failure = executor.run({
      runId: "run-retry",
      stage: "author",
      command: ["node", "script.js"],
      timeoutMs: 60_000,
    });

    await expect(failure).rejects.toThrow(
      "automatic retry was suppressed to prevent duplicate execution",
    );
    await expect(failure).rejects.toMatchObject({ name: "VercelCommandStartError" });

    expect(
      fixture.calls.filter(
        (call) => call.method === "POST" && call.path.split("?")[0]?.endsWith("/cmd"),
      ),
    ).toHaveLength(1);
    expect(fixture.calls.at(-1)?.method).toBe("DELETE");
  });

  test("retains the SDK retry for a confirmed rate-limit rejection", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandStartStatuses.push(429, 200);
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    const result = await executor.run({
      runId: "run-rate-limit",
      stage: "author",
      command: ["true"],
      timeoutMs: 60_000,
    });

    expect(result.exitCode).toBe(7);
    expect(
      fixture.calls.filter(
        (call) => call.method === "POST" && call.path.split("?")[0]?.endsWith("/cmd"),
      ),
    ).toHaveLength(2);
    expect(fixture.calls.at(-1)?.method).toBe("DELETE");
  });

  test("retries sandbox creation after a provider-directed rate-limit delay", async () => {
    const fixture = new VercelSdkFixture();
    fixture.createStatuses.push(429, 200);
    fixture.createRetryAfter = "30";
    const sleeps: number[] = [];
    const executor = new VercelSandboxExecutor(config, fixture.fetch, async (delayMs, signal) => {
      signal.throwIfAborted();
      sleeps.push(delayMs);
    });

    const result = await executor.run({
      runId: "create-rate-limit",
      stage: "author",
      command: ["true"],
      timeoutMs: 60_000,
    });

    const creates = fixture.calls.filter(
      (call) => call.method === "POST" && call.path.split("?")[0] === "/api/v3/sandboxes",
    );
    expect(result.exitCode).toBe(7);
    expect(sleeps).toEqual([30_000]);
    expect(creates).toHaveLength(2);
    expect(new Set(creates.map((call) => JSON.parse(call.body ?? "{}").name)).size).toBe(1);
  });

  test("bounds provider-directed sandbox creation retries", async () => {
    const fixture = new VercelSdkFixture();
    fixture.createStatuses.push(429, 429, 429);
    fixture.createRetryAfter = "30";
    const sleeps: number[] = [];
    const executor = new VercelSandboxExecutor(config, fixture.fetch, async (delayMs, signal) => {
      signal.throwIfAborted();
      sleeps.push(delayMs);
    });

    const failure = executor.run({
      runId: "create-rate-limit-exhausted",
      stage: "author",
      command: ["true"],
      timeoutMs: 60_000,
    });

    await expect(failure).rejects.toMatchObject({ response: { status: 429 } });
    expect(
      fixture.calls.filter(
        (call) => call.method === "POST" && call.path.split("?")[0] === "/api/v3/sandboxes",
      ),
    ).toHaveLength(3);
    expect(sleeps.slice(0, 2)).toEqual([30_000, 30_000]);
    expect(
      fixture.calls.some(
        (call) => call.method === "GET" && call.path.startsWith("/api/v2/sandboxes/selfbench-"),
      ),
    ).toBe(false);
  });

  test("deletes a sandbox when its input upload fails", async () => {
    const fixture = new VercelSdkFixture();
    fixture.writeFails = true;
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    await expect(
      executor.run({
        runId: "upload-failure",
        stage: "author",
        command: ["true"],
        files: [{ path: "/work/input", contents: "data" }],
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("simulated upload failure");
    expect(
      fixture.calls.some(
        (call) => call.method === "POST" && call.path.split("?")[0]?.endsWith("/cmd"),
      ),
    ).toBe(false);
    expect(fixture.calls.at(-1)?.method).toBe("DELETE");
  });

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

  test("cancels creation after allocation and recovers the sandbox by exact name", async () => {
    const fixture = new VercelSdkFixture();
    fixture.createHoldsAfterAllocation = true;
    let notifyAllocated = (): void => {};
    const allocated = new Promise<void>((resolve) => {
      notifyAllocated = resolve;
    });
    fixture.onCreateAllocated = notifyAllocated;
    const executor = new VercelSandboxExecutor(config, fixture.fetch);
    const controller = new AbortController();

    const failure = executor.run(
      {
        runId: "cancel-during-create",
        stage: "author",
        command: ["true"],
        timeoutMs: 60_000,
      },
      { signal: controller.signal },
    );
    await allocated;
    controller.abort(new Error("cancelled while create response was pending"));

    await expect(failure).rejects.toThrow("cancelled while create response was pending");
    expect(fixture.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(fixture.sandboxExists).toBe(false);
  });

  test("deletes the whole sandbox and reports output inactivity", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandExitCode = null;
    fixture.logsMode = "hold";
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    const failure = executor.run({
      runId: "inactivity",
      stage: "review",
      command: ["node", "script.js"],
      timeoutMs: 60_000,
      inactivityTimeoutMs: 20,
    });

    await expect(failure).rejects.toBeInstanceOf(InactivityTimeoutError);
    expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(true);
  });

  test("resets output inactivity only when nonempty output arrives", async () => {
    const fixture = new VercelSdkFixture();
    fixture.logsMode = "periodic";
    const progress: number[] = [];
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    const result = await executor.run(
      {
        runId: "periodic-output",
        stage: "author",
        command: ["true"],
        timeoutMs: 1_000,
        inactivityTimeoutMs: 25,
      },
      { onProgress: ({ bytes }) => progress.push(bytes) },
    );

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("tick-1\ntick-2\ntick-3\ntick-4\n");
    expect(progress).toEqual([7, 7, 7, 7]);
  });

  test("does not treat empty log events as output activity", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandExitCode = null;
    fixture.logsMode = "empty-pulse";
    const progress: number[] = [];
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    const failure = executor.run(
      {
        runId: "empty-output",
        stage: "author",
        command: ["true"],
        timeoutMs: 200,
        inactivityTimeoutMs: 30,
      },
      { onProgress: ({ bytes }) => progress.push(bytes) },
    );

    await expect(failure).rejects.toBeInstanceOf(InactivityTimeoutError);
    expect(progress).toEqual([]);
  });

  test("honors cancellation triggered by streamed progress and deletes the sandbox", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandExitCode = null;
    fixture.logsMode = "one-then-hold";
    const executor = new VercelSandboxExecutor(config, fixture.fetch);
    const controller = new AbortController();

    const failure = executor.run(
      {
        runId: "cancel-progress",
        stage: "author",
        command: ["node", "script.js"],
        timeoutMs: 60_000,
      },
      {
        signal: controller.signal,
        onProgress: () => controller.abort(new Error("cancelled from progress")),
      },
    );

    await expect(failure).rejects.toThrow("cancelled from progress");
    expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(true);
  });

  test("enforces an overall hard timeout even when the provider never settles", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandExitCode = null;
    fixture.logsMode = "one-then-hold";
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    const result = await executor.run({
      runId: "hard-timeout",
      stage: "author",
      command: ["node", "script.js"],
      timeoutMs: 100,
    });

    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("first\n");
    expect(result.stderr).toBe("");
    expect(result.outputs).toEqual({});
    expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(true);
  });

  test("returns a hard-timeout result and recovers allocation while create is pending", async () => {
    const fixture = new VercelSdkFixture();
    fixture.createHoldsAfterAllocation = true;
    const executor = new VercelSandboxExecutor(config, fixture.fetch);

    const result = await executor.run({
      runId: "hard-timeout-during-create",
      stage: "author",
      command: ["true"],
      timeoutMs: 100,
    });

    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(fixture.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(fixture.sandboxExists).toBe(false);
  });

  test("recovers a failed direct delete by exact name without resuming", async () => {
    const fixture = new VercelSdkFixture();
    fixture.deleteFailuresRemaining = 1;
    const sleeps: number[] = [];
    const executor = new VercelSandboxExecutor(config, fixture.fetch, async (delayMs, signal) => {
      signal.throwIfAborted();
      sleeps.push(delayMs);
    });

    const result = await executor.run({
      runId: "cleanup-recovery",
      stage: "author",
      command: ["true"],
      timeoutMs: 60_000,
    });

    expect(result.exitCode).toBe(7);
    expect(sleeps).toEqual([1_000]);
    expect(fixture.calls.filter((call) => call.method === "DELETE")).toHaveLength(2);
    const get = fixture.calls.find(
      (call) =>
        call.method === "GET" && call.path.startsWith(`/api/v2/sandboxes/${fixture.sandboxName}?`),
    );
    expect(get?.path).toContain("resume=false");
  });

  test("deletes a late-visible sandbox after losing its create response", async () => {
    const fixture = new VercelSdkFixture();
    fixture.createFailsAfterAllocation = true;
    fixture.getNotFoundResponsesRemaining = 1;
    const sleeps: number[] = [];
    const executor = new VercelSandboxExecutor(config, fixture.fetch, async (delayMs, signal) => {
      signal.throwIfAborted();
      sleeps.push(delayMs);
    });

    await expect(
      executor.run({
        runId: "late-create",
        stage: "cancelled",
        command: ["true"],
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow("simulated lost create response");

    expect(
      fixture.calls.filter(
        (call) =>
          call.method === "GET" &&
          call.path.startsWith(`/api/v2/sandboxes/${fixture.sandboxName}?`),
      ),
    ).toHaveLength(2);
    expect(fixture.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(sleeps).toEqual([250]);
  });

  test("fails cleanup when an ambiguous create never becomes visible", async () => {
    const fixture = new VercelSdkFixture();
    fixture.createFailsAfterAllocation = true;
    fixture.getNotFoundResponsesRemaining = 4;
    const sleeps: number[] = [];
    const executor = new VercelSandboxExecutor(config, fixture.fetch, async (delayMs, signal) => {
      signal.throwIfAborted();
      sleeps.push(delayMs);
    });

    let failure: unknown;
    try {
      await executor.run({
        runId: "hidden-create",
        stage: "author",
        command: ["true"],
        timeoutMs: 60_000,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ name: "AbortError" });
    expect(String(failure)).toContain("simulated lost create response");
    expect(String(failure)).toContain("Vercel sandbox cleanup also failed");
    expect(String(failure)).toContain(
      "sandbox absence remained unconfirmed after an ambiguous create failure",
    );
    expect(
      fixture.calls.filter(
        (call) =>
          call.method === "GET" &&
          call.path.startsWith(`/api/v2/sandboxes/${fixture.sandboxName}?`),
      ),
    ).toHaveLength(4);
    expect(fixture.calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(fixture.sandboxExists).toBe(true);
    expect(sleeps).toEqual([250, 750, 1_500]);
  });

  test("retains the primary failure while surfacing a cleanup failure", async () => {
    const fixture = new VercelSdkFixture();
    fixture.commandStartStatus = 503;
    fixture.deleteFailuresRemaining = 1;
    fixture.getFails = true;
    fixture.getFailureMessage = `simulated cleanup failure with ${config.credentials.token}`;
    const executor = new VercelSandboxExecutor(config, fixture.fetch, async (_delayMs, signal) => {
      signal.throwIfAborted();
    });

    let failure: unknown;
    try {
      await executor.run({
        runId: "dual-failure",
        stage: "author",
        command: ["true"],
        timeoutMs: 60_000,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ name: "VercelCommandStartError" });
    const publicMessage = String(failure);
    expect(publicMessage).toContain("Vercel sandbox cleanup also failed");
    expect(publicMessage).toContain("failed to delete Vercel sandbox");
    expect(publicMessage).toContain("[redacted]");
    expect(publicMessage).not.toContain(config.credentials.token);
    const attachedCleanup = (failure as Error & { cleanupError?: unknown }).cleanupError;
    expect(String(attachedCleanup)).toContain("[redacted]");
    expect(String(attachedCleanup)).not.toContain(config.credentials.token);
  });
});
