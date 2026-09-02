import { describe, expect, test } from "bun:test";
import {
  assertPiSessionFile,
  collectPiSessionScript,
  PI_RESUMED_SESSION_PATH,
  PI_SESSION_DIRECTORY,
  PI_SESSION_OUTPUT_PATH,
  piSessionArguments,
  sessionArtifactKey,
} from "../src/pi-session.js";

const header = JSON.stringify({
  type: "session",
  version: 3,
  id: "0199a3f0-1111-7000-8000-000000000000",
  timestamp: "2026-09-02T00:00:00.000Z",
  cwd: "/work/repo",
});

describe("pi session helpers", () => {
  test("names session artifacts per stage, candidate, and round", () => {
    expect(sessionArtifactKey("run-1", "authoring", "cand", 2)).toBe(
      "runs/run-1/authoring/cand/session/round-2.jsonl",
    );
    expect(sessionArtifactKey("run-1", "verification", "cand", 1)).toBe(
      "runs/run-1/verification/cand/session/round-1.jsonl",
    );
  });

  test("passes a session directory for fresh rounds and an explicit file when resuming", () => {
    expect(piSessionArguments(false)).toEqual(["--session-dir", PI_SESSION_DIRECTORY]);
    expect(piSessionArguments(true)).toEqual([
      "--session-dir",
      PI_SESSION_DIRECTORY,
      "--session",
      PI_RESUMED_SESSION_PATH,
    ]);
    expect(PI_RESUMED_SESSION_PATH.startsWith(`${PI_SESSION_DIRECTORY}/`)).toBe(true);
  });

  test("validates the JSONL session header and entries", () => {
    const entries = [header, JSON.stringify({ type: "message", id: "m1", message: {} })];
    expect(assertPiSessionFile(Buffer.from(`${entries.join("\n")}\n`))).toEqual({
      id: "0199a3f0-1111-7000-8000-000000000000",
      cwd: "/work/repo",
      entries: 2,
    });
    expect(() => assertPiSessionFile(Buffer.from(""))).toThrow("pi session file is empty");
    expect(() => assertPiSessionFile(Buffer.from('{"type":"message"}\n'))).toThrow(
      "does not start with a session header",
    );
    expect(() => assertPiSessionFile(Buffer.from(`${header}\nnot json\n`))).toThrow(
      "pi session line 2 is not JSON",
    );
  });

  test("collects the resumed file first and otherwise the single new session file", () => {
    const script = collectPiSessionScript();
    expect(script).toContain(`if [ -f ${PI_RESUMED_SESSION_PATH} ]`);
    expect(script).toContain(`ls -1 ${PI_SESSION_DIRECTORY}/*.jsonl`);
    expect(script).toContain(`cp "$session_file" ${PI_SESSION_OUTPUT_PATH}`);
  });
});
