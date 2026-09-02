import type { VerifyStage } from "./contracts.js";

/** Directory pi writes session files into inside the sandbox. */
export const PI_SESSION_DIRECTORY = "/work/session";
/** Single file the sandbox script copies the session to so providers can collect it. */
export const PI_SESSION_OUTPUT_PATH = "/work/session.jsonl";
/** Where a previous round's session is restored before resuming. */
export const PI_RESUMED_SESSION_PATH = `${PI_SESSION_DIRECTORY}/resume.jsonl`;

export interface PiSessionSummary {
  readonly id: string;
  readonly cwd?: string;
  readonly entries: number;
}

export function sessionArtifactKey(
  runId: string,
  stage: VerifyStage,
  candidateId: string,
  round: number,
): string {
  return `runs/${runId}/${stage}/${candidateId}/session/round-${round}.jsonl`;
}

/**
 * pi CLI flags for session continuity. A fresh round lets pi create a new session file under the
 * session directory; a resumed round opens the restored file explicitly so pi appends to it.
 */
export function piSessionArguments(resume: boolean): readonly string[] {
  return [
    "--session-dir",
    PI_SESSION_DIRECTORY,
    ...(resume ? ["--session", PI_RESUMED_SESSION_PATH] : []),
  ];
}

/** Validates a pi JSONL session file: a `session` header followed by JSON entries. */
export function assertPiSessionFile(bytes: Uint8Array): PiSessionSummary {
  const text = Buffer.from(bytes).toString("utf8");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const first = lines[0];
  if (!first) {
    throw new Error("pi session file is empty");
  }
  const header = parseEntry(first, 1);
  if (header.type !== "session" || typeof header.id !== "string" || header.id.length === 0) {
    throw new Error("pi session file does not start with a session header");
  }
  for (const [index, line] of lines.slice(1).entries()) {
    parseEntry(line, index + 2);
  }
  return {
    id: header.id,
    ...(typeof header.cwd === "string" ? { cwd: header.cwd } : {}),
    entries: lines.length,
  };
}

/** Bash snippet that copies the single pi session file to the collectable output path. */
export function collectPiSessionScript(): string {
  return [
    "collect_session() {",
    `  local session_file`,
    `  if [ -f ${PI_RESUMED_SESSION_PATH} ]; then session_file=${PI_RESUMED_SESSION_PATH}; else session_file="$(ls -1 ${PI_SESSION_DIRECTORY}/*.jsonl 2>/dev/null | head -n 1)"; fi`,
    `  if [ -n "$session_file" ] && [ -f "$session_file" ]; then cp "$session_file" ${PI_SESSION_OUTPUT_PATH}; fi`,
    "}",
  ].join("\n");
}

function parseEntry(line: string, lineNumber: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`pi session line ${lineNumber} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`pi session line ${lineNumber} is not an object`);
  }
  return parsed as Record<string, unknown>;
}
