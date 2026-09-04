import { describe, expect, test } from "bun:test";
import { SandboxExecutionError } from "../../../../src/sandbox/contracts.js";
import { E2BSandboxExecutor } from "../../../../src/sandbox/providers/e2b/executor.js";
import {
  e2bFixtureConfig as config,
  E2BSdkFixture,
  fastLifecycleTimings,
} from "../../../support/e2b-sdk-fixture.js";

describe("E2BSandboxExecutor remote files", () => {
  test("has the sandbox fetch remote files by URL before the command runs", async () => {
    const fixture = new E2BSdkFixture();
    const executor = new E2BSandboxExecutor(config, fixture.api);

    await executor.run(
      {
        runId: "run-e2b",
        stage: "verify",
        command: ["bash", "-lc", "true"],
        files: [
          { path: "/work/prompt.txt", contents: "hello" },
          {
            path: "/work/task.tar.gz",
            url: "https://storage.example/bundle?sig=x",
            sha256: "ab12",
          },
        ],
        timeoutMs: 60_000,
        inactivityTimeoutMs: 10_000,
      },
      {},
    );

    expect(Buffer.from(fixture.uploadedFiles.get("/work/prompt.txt") ?? []).toString()).toBe(
      "hello",
    );
    expect(fixture.uploadedFiles.has("/work/task.tar.gz")).toBe(false);
    expect(fixture.commands).toHaveLength(2);
    expect(fixture.commands[0]).toContain("curl -fsSL --retry 5");
    expect(fixture.commands[0]).toContain("'https://storage.example/bundle?sig=x'");
    expect(fixture.commands[0]).toContain("'ab12' '/work/task.tar.gz' | sha256sum -c -");
    expect(fixture.commands[1]).toContain("true");
  });
});
