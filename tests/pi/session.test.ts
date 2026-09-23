import { describe, expect, test } from "bun:test";
import { sessionProviderError } from "../../src/harnesses/pi/session.js";

describe("pi session helpers", () => {
  test("reports the provider error that ended a session", () => {
    const entry = (message: Record<string, unknown>) =>
      JSON.stringify({ type: "message", id: "x", timestamp: "t", message });
    const failed = [
      JSON.stringify({ type: "session", id: "s", version: 3, timestamp: "t", cwd: "/work/repo" }),
      entry({ role: "user", content: [{ type: "text", text: "go" }] }),
      entry({
        role: "assistant",
        content: [{ type: "text", text: "looking" }],
        stopReason: "stop",
      }),
      entry({ role: "assistant", content: [], stopReason: "error", errorMessage: "Not Found" }),
    ].join("\n");
    expect(sessionProviderError(Buffer.from(failed))).toBe("Not Found");
    const fine = [
      JSON.stringify({ type: "session", id: "s", version: 3, timestamp: "t", cwd: "/work/repo" }),
      entry({ role: "assistant", content: [], stopReason: "error", errorMessage: "transient" }),
      entry({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }),
    ].join("\n");
    expect(sessionProviderError(Buffer.from(fine))).toBeUndefined();
  });
});
