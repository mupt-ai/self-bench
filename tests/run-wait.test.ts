import { describe, expect, test } from "bun:test";
import { type PolledRunStatus, waitForRun } from "../src/run-wait.js";

describe("waitForRun", () => {
  test("waits for completion and reports only phase changes", async () => {
    const statuses: PolledRunStatus[] = [
      { phase: "queued" },
      { phase: "authoring" },
      { phase: "authoring" },
      { phase: "complete", export: { uri: "artifact" } },
    ];
    const phases: string[] = [];
    const result = await waitForRun({
      poll: async () => statuses.shift() ?? { phase: "complete" },
      delay: async () => undefined,
      onPhase: (status) => phases.push(status.phase),
    });

    expect(result.phase).toBe("complete");
    expect(phases).toEqual(["queued", "authoring", "complete"]);
  });

  test("fails immediately on a terminal unsuccessful phase", async () => {
    expect(
      waitForRun({
        poll: async () => ({ phase: "blocked", error: "candidate pool exhausted" }),
        delay: async () => undefined,
      }),
    ).rejects.toThrow("SelfBench run blocked: candidate pool exhausted");
  });
});
