import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts.js";
import { toolCallNames } from "../src/pi-session.js";
import { SandboxExecutionError } from "../src/sandbox/index.js";
import {
  archiveSandboxResult,
  classifyRound,
  piExitCodeFrom,
  reconcileWrapperStatus,
  type SandboxRoundResult,
  WRAPPER_STATUS_PATH,
  wrapperStatusFrom,
} from "../src/temporal/activities/round-outcome.js";
import { runSandboxWithFailureLog } from "../src/temporal/activities/runtime.js";

const base = {
  round: 1,
  exitCode: 0,
  missing: [],
  sessionCollected: true,
  toolCalls: [] as string[],
};

describe("round classification", () => {
  test("a delivered terminal tool call with a missing output is an infrastructure error", () => {
    expect(
      classifyRound({
        ...base,
        missing: ["/work/verdict/verdict.json"],
        toolCalls: ["verify", "accept_task"],
      }),
    ).toEqual({
      kind: "infrastructure",
      reason:
        "round 1: output /work/verdict/verdict.json missing (pi exit 0 after accept_task); the sandbox delivered but collection failed",
    });
    expect(classifyRound({ ...base, sessionCollected: false })).toEqual({
      kind: "infrastructure",
      reason:
        "round 1: session output missing (pi exit 0); the sandbox delivered but collection failed",
    });
  });

  test("a non-zero exit without a terminal call is a rejection naming the code", () => {
    expect(
      classifyRound({ ...base, exitCode: 7, piExitCode: 7, finalMessage: "no public seam" }),
    ).toEqual({
      kind: "rejected",
      reason: "round 1: pi exited with code 7; agent said: no public seam",
    });
    expect(classifyRound({ ...base, round: 2, exitCode: 1, piExitCode: 0 })).toEqual({
      kind: "rejected",
      reason:
        "round 2: pi exited 0 without a terminal tool call and the wrapper exited with code 1",
    });
  });

  test("a sandbox that died mid-round or a wrapper failure after a terminal call is retried", () => {
    expect(classifyRound({ ...base, exitCode: 124 })).toEqual({
      kind: "infrastructure",
      reason: "round 1: sandbox died mid-round (exit 124) before a terminal tool call",
    });
    expect(classifyRound({ ...base, exitCode: 1, sessionCollected: false })).toEqual({
      kind: "infrastructure",
      reason:
        "round 1: sandbox died mid-round (exit 1, no session collected) before a terminal tool call",
    });
    expect(classifyRound({ ...base, exitCode: 1, toolCalls: ["submit_task"] })).toEqual({
      kind: "infrastructure",
      reason: "round 1: wrapper exited with code 1 after submit_task was recorded",
    });
    expect(classifyRound(base)).toEqual({ kind: "ok" });
  });

  test("archives the sandbox result with collected outputs and reports what is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-round-outcome-"));
    try {
      const store = new LocalArtifactStore(root);
      const missing = await archiveSandboxResult(
        store,
        "runs/r/verification/c/round-1/sandbox-result.json",
        {
          sandboxId: "sb-1",
          exitCode: 0,
          stdout:
            "…\n[selfbench] pi exited with 0\n[selfbench] outputs: /work/verdict/verdict.json:present(42B)\n",
          stderr: "warning\n",
          outputs: { "/work/session.jsonl": Buffer.from("{}") },
        },
        ["/work/verdict/verdict.json", "/work/session.jsonl"],
      );
      expect(missing).toEqual(["/work/verdict/verdict.json"]);
      const archived = JSON.parse(
        Buffer.from(
          (await store.getByKey("runs/r/verification/c/round-1/sandbox-result.json")) ?? [],
        ).toString(),
      );
      expect(archived).toMatchObject({
        sandboxId: "sb-1",
        exitCode: 0,
        piExitCode: 0,
        outputs: [
          { path: "/work/verdict/verdict.json", collected: false, sizeBytes: 0 },
          { path: "/work/session.jsonl", collected: true, sizeBytes: 2 },
        ],
        stderrTail: "warning",
      });
      expect(archived.stdoutTail).toContain("[selfbench] outputs:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    expect(piExitCodeFrom("x\n[selfbench] pi exited with 3\n")).toBe(3);
    expect(piExitCodeFrom("nothing")).toBeUndefined();
  });

  test("the wrapper's own status overrides a provider exit code, except for a hard timeout", () => {
    const finished: SandboxRoundResult = {
      sandboxId: "sb-2",
      exitCode: 1,
      stdout: "[selfbench] pi exited with 0\n",
      stderr: "",
      outputs: { [WRAPPER_STATUS_PATH]: Buffer.from("0\n") },
    };
    expect(wrapperStatusFrom(finished.outputs)).toBe(0);
    expect(wrapperStatusFrom({})).toBeUndefined();
    expect(wrapperStatusFrom({ [WRAPPER_STATUS_PATH]: Buffer.from("garbage") })).toBeUndefined();
    expect(reconcileWrapperStatus(finished)).toEqual({
      ...finished,
      exitCode: 0,
      providerExitCode: 1,
    });
    expect(reconcileWrapperStatus({ ...finished, exitCode: 0 })).toEqual({
      ...finished,
      exitCode: 0,
    });
    expect(reconcileWrapperStatus({ ...finished, exitCode: 124 })).toEqual({
      ...finished,
      exitCode: 124,
    });
    expect(reconcileWrapperStatus({ ...finished, outputs: {} })).toEqual({
      ...finished,
      outputs: {},
    });
  });

  test("a provider failure after the wrapper finished becomes a result instead of a retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-round-outcome-"));
    try {
      const store = new LocalArtifactStore(root);
      const partial = {
        sandboxId: "sb-3",
        exitCode: 1,
        stdout: "[selfbench] pi exited with 0\n",
        stderr: "",
        outputs: {
          [WRAPPER_STATUS_PATH]: Buffer.from("0\n"),
          "/work/session.jsonl": Buffer.from("{}"),
        },
      };
      const recovered = await runSandboxWithFailureLog(store, "runs/r/log", async () => {
        throw new SandboxExecutionError("2: [unknown] terminated; E2B sandbox sb-3", partial);
      });
      expect(recovered.exitCode).toBe(0);
      expect(recovered.outputs["/work/session.jsonl"]).toBeDefined();
      expect(recovered.stderr).toContain(
        "provider failed after the wrapper finished with status 0",
      );
      expect(await store.getByKey("runs/r/log")).toBeUndefined();
      await expect(
        runSandboxWithFailureLog(store, "runs/r/log", async () => {
          throw new SandboxExecutionError("died", { ...partial, outputs: {} });
        }),
      ).rejects.toThrow(/died; partial log:/);
      expect(await store.getByKey("runs/r/log")).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads terminal tool calls from a pi session", () => {
    const session = [
      JSON.stringify({ type: "session", id: "s", version: 3, timestamp: "t", cwd: "/work/repo" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "toolCall", name: "verify", id: "1", arguments: {} },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", toolName: "verify", content: [] },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", name: "accept_task", id: "2", arguments: {} }],
        },
      }),
    ].join("\n");
    expect(toolCallNames(Buffer.from(session))).toEqual(["verify", "accept_task"]);
  });
});
