import type { ArtifactGroup } from "../types";

export const MAX_SUMMARY_BYTES = 256 * 1024;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export interface ArtifactSummary {
  text: string;
  tone: "ok" | "bad" | "warn" | "";
}

/** One line that says what a pipeline report concluded, without opening it. */
export function summarizeArtifact(
  group: ArtifactGroup,
  key: string,
  body: string,
): ArtifactSummary {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { text: firstMeaningfulLine(body) ?? "", tone: "" };
  }
  if (typeof value !== "object" || value === null) return { text: body.slice(0, 160), tone: "" };
  const record = value as Record<string, unknown>;
  switch (group) {
    case "audits":
      return summarizeAudit(record);
    case "environment-preflights":
      return summarizeVerdict(record, "reason");
    case "validation":
    case "validation-repairs":
      return summarizeRewards(record, key);
    case "reviews":
      return summarizeReview(record);
    case "provenance":
      return {
        text: [record.sourceType, record.sessionId].filter(Boolean).map(String).join(" · "),
        tone: "",
      };
    default:
      if (typeof record.testCommand === "string") {
        const tests = Array.isArray(record.failToPass) ? record.failToPass.length : 0;
        const regressions = Array.isArray(record.passToPass) ? record.passToPass.length : 0;
        return {
          text: `${String(record.difficulty ?? "")} · ${tests} f2p · ${regressions} p2p · ${record.testCommand}`,
          tone: "",
        };
      }
      return summarizeVerdict(record, "reason");
  }
}

function summarizeAudit(record: Record<string, unknown>): ArtifactSummary {
  const metrics = record.metrics as Record<string, unknown> | undefined;
  const blockers = Array.isArray(record.blockers) ? record.blockers.map(String) : [];
  if (record.accepted === true) {
    const detail = metrics
      ? ` · ${metrics.implementationFiles ?? "?"} impl files · ${metrics.implementationChangedLines ?? "?"} lines · ${metrics.testFiles ?? "?"} test files`
      : "";
    return { text: `accepted${detail}`, tone: "ok" };
  }
  return { text: `rejected · ${blockers.join("; ") || "no blockers listed"}`, tone: "bad" };
}

function summarizeVerdict(record: Record<string, unknown>, reasonKey: string): ArtifactSummary {
  const accepted = record.accepted;
  const reason = typeof record[reasonKey] === "string" ? (record[reasonKey] as string) : "";
  const line = firstMeaningfulLine(reason);
  if (accepted === true) return { text: `accepted${line ? ` · ${line}` : ""}`, tone: "ok" };
  if (accepted === false) return { text: `failed · ${line ?? "no reason recorded"}`, tone: "bad" };
  const keys = Object.keys(record).slice(0, 6).join(", ");
  return { text: line ?? keys, tone: "" };
}

function summarizeRewards(record: Record<string, unknown>, key: string): ArtifactSummary {
  const rewards = findRewards(record);
  if (!rewards) {
    const exception = findKey(record, "exception");
    return exception
      ? { text: `exception · ${String(exception).slice(0, 160)}`, tone: "bad" }
      : { text: "no rewards recorded", tone: "warn" };
  }
  const fields = [
    "patch_applied",
    "fail_to_pass",
    "pass_to_pass",
    "deterministic",
    "setup_completed",
  ].filter((field) => field in rewards);
  const text = fields.map((field) => `${field}=${String(rewards[field])}`).join("  ");
  const oracle = key.endsWith("oracle.json");
  const passed = oracle
    ? fields.every((field) => Number(rewards[field]) >= 1)
    : Number(rewards.fail_to_pass) === 0 &&
      Number(rewards.pass_to_pass) >= 1 &&
      Number(rewards.setup_completed) >= 1;
  return { text, tone: passed ? "ok" : "bad" };
}

function summarizeReview(record: Record<string, unknown>): ArtifactSummary {
  const verdict = typeof record.verdict === "string" ? record.verdict : "?";
  const reason = typeof record.reason === "string" ? record.reason : "";
  return {
    text: `${verdict} · ${reason.replace(/\s+/g, " ").slice(0, 220)}`,
    tone: verdict === "clean" ? "ok" : "bad",
  };
}

function findRewards(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 6 || typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if ("fail_to_pass" in record && "pass_to_pass" in record) return record;
  for (const child of Object.values(record)) {
    const found = findRewards(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function findKey(value: unknown, key: string, depth = 0): unknown {
  if (depth > 6 || typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (key in record && record[key] !== null && record[key] !== undefined) return record[key];
  for (const child of Object.values(record)) {
    const found = findKey(child, key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** What a sandbox or verifier log ended with: the last error-looking line, else the last line. */
export function summarizeLogTail(tail: string): ArtifactSummary {
  const lines = tail
    .split("\n")
    .map((line) => line.replace(ANSI_ESCAPE, "").trim())
    .filter(
      (line) =>
        line &&
        line.length < 400 &&
        !line.startsWith("[selfbench] agent process") &&
        !line.startsWith("{") &&
        !line.includes("\\n") &&
        !line.includes('"role":') &&
        !/^[A-Za-z0-9+/_=-]{80,}$/.test(line) &&
        !line.startsWith("WARN") &&
        !/^\s*at /.test(line),
    );
  const errorLine = [...lines]
    .reverse()
    .find((line) =>
      /error|failed|rejected|denied|not found|refused|timed out|looks like a secret|must contain|exit(ed)? (code|status) [1-9]/i.test(
        line,
      ),
    );
  if (errorLine) return { text: errorLine.slice(0, 240), tone: "bad" };
  const last = lines[lines.length - 1];
  return { text: last ? `ends with: ${last.slice(0, 200)}` : "empty log", tone: "" };
}

export function firstMeaningfulLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.replace(ANSI_ESCAPE, "").trim())
    .filter((line) => line && !line.startsWith("[truncated") && !line.startsWith("WARN"));
  const meaningful = lines.find((line) =>
    /failed|rejected|error|requires|exhausted|not found|denied|timed out|refused|missing/i.test(
      line,
    ),
  );
  return (meaningful ?? lines[0])?.slice(0, 220);
}
