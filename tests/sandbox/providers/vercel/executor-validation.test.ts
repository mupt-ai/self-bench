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
});
