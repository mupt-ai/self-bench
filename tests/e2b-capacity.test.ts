import { expect, test } from "bun:test";
import { createSandboxExecutor, SandboxCapacityError } from "../src/sandbox/index.js";

// Workflows wait on this error instead of failing, so it must survive the SDK's error mapping
// and every executor wrapper.
test("E2B refusing a sandbox at the team quota is a capacity error; other failures are not", async () => {
  let status = 429;
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        { code: status, message: "You have reached the maximum number of concurrent sandboxes" },
        { status },
      ),
  });
  const previous = process.env.E2B_API_URL;
  process.env.E2B_API_URL = server.url.origin;
  try {
    const executor = createSandboxExecutor({
      kind: "e2b",
      image: "selfbench-runtime:test",
      timeoutCapMs: 3_600_000,
      credentials: { apiKey: "e2b_test" },
    });
    const request = { runId: "run", stage: "discover-0-0", command: ["true"], timeoutMs: 60_000 };
    await expect(executor.start(request)).rejects.toBeInstanceOf(SandboxCapacityError);
    status = 500;
    const error = await executor.start(request).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SandboxCapacityError);
  } finally {
    if (previous === undefined) delete process.env.E2B_API_URL;
    else process.env.E2B_API_URL = previous;
    server.stop(true);
  }
});
