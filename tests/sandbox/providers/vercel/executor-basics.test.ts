import { describe, expect, test } from "bun:test";
import { VercelSandboxExecutor } from "../../../../src/sandbox/providers/vercel/executor.js";
import {
  vercelFixtureConfig as config,
  vercelFixtureImage as image,
  vercelRequestBody as requestBody,
  VercelSdkFixture,
} from "../../../support/vercel-sdk-fixture.js";

describe("VercelSandboxExecutor basics", () => {
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
});
