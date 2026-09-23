import type { CandidateDefinitionSummary } from "./types.js";

const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function reasonSummary(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const lines = reason
    .split("\n")
    .map((line) => line.replace(ANSI_ESCAPE, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("[truncated"));
  const meaningful = lines.find((line) =>
    /failed|rejected|error|requires|exhausted|not found|denied|timed out|refused/i.test(line),
  );
  const chosen = meaningful ?? lines[0];
  return chosen ? chosen.slice(0, 240) : undefined;
}

export function testRunner(testCommand: string): string {
  const command = testCommand.toLowerCase();
  const patterns: readonly [RegExp, string][] = [
    [/pytest/, "pytest"],
    [/vitest/, "vitest"],
    [/\bjest\b/, "jest"],
    [/\bmocha\b/, "mocha"],
    [/playwright/, "playwright"],
    [/cargo (test|nextest)/, "cargo"],
    [/\bgo test\b/, "go test"],
    [/node --test|node:test/, "node:test"],
    [/hogli/, "hogli"],
    [/\bmypy\b|\bruff\b|\beslint\b|\btsc\b/, "lint"],
    [/\bpnpm\b|\bnpm\b|\byarn\b|\bbun\b/, "package script"],
    [/\bmake\b/, "make"],
    [/\bbash\b|\bsh\b/, "shell"],
  ];
  for (const [pattern, label] of patterns) {
    if (pattern.test(command)) return label;
  }
  return "other";
}

export function summarizeDefinition(text: string): CandidateDefinitionSummary | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const value = parsed as Record<string, unknown>;
  const testCommand = typeof value.testCommand === "string" ? value.testCommand : "";
  return {
    testCommand,
    runner: testRunner(testCommand),
    failToPass: Array.isArray(value.failToPass) ? value.failToPass.length : 0,
    passToPass: Array.isArray(value.passToPass) ? value.passToPass.length : 0,
    testPaths: Array.isArray(value.testPaths) ? value.testPaths.length : 0,
    workdir: typeof value.workdir === "string" ? value.workdir : ".",
    sourcePr: typeof value.sourcePr === "number" ? value.sourcePr : 0,
    sourceUrl: typeof value.sourceUrl === "string" ? value.sourceUrl : "",
    baseCommit: typeof value.baseCommit === "string" ? value.baseCommit : "",
  };
}
