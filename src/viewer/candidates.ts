import type { ArtifactStore } from "../artifacts.js";
import type { RunStatus, TaskProgress } from "../contracts.js";
import { parallelMap } from "../parallel.js";
import type {
  CandidateDefinitionSummary,
  CandidateList,
  CandidateStage,
  CandidateSummary,
} from "./types.js";

const DEFINITION_CONCURRENCY = 16;
const MAX_CACHED_DEFINITIONS = 5_000;
const definitionCache = new Map<string, CandidateDefinitionSummary | null>();
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

export function candidateStage(task: Pick<TaskProgress, "status" | "reason">): CandidateStage {
  switch (task.status) {
    case "accepted":
      return "accepted";
    case "infrastructure_failed":
      return "infrastructure";
    case "rejected":
      return rejectedStage(task.reason ?? "");
    default:
      return "in_progress";
  }
}

function rejectedStage(reason: string): CandidateStage {
  const head = reason.slice(0, 400);
  if (/environment authoring/i.test(head)) return "environment";
  if (
    /repeated task ID|authoring did not produce|authoring checkpoint|authoring failed/i.test(head)
  ) {
    return "authoring";
  }
  if (/mode requires|audit rejected|audit blockers/i.test(head)) return "audit";
  if (/validation repair|Harbor gates failed|validation rejected/i.test(head)) return "validation";
  if (/test repair|coupling|review rejected/i.test(head)) return "review";
  if (/preflight|smoke/i.test(head)) return "preflight";
  if (/environment/i.test(head)) return "environment";
  return "preflight";
}

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

export async function listCandidates(
  store: ArtifactStore,
  status: RunStatus,
): Promise<CandidateList> {
  const candidates = await parallelMap(status.tasks, DEFINITION_CONCURRENCY, async (task) => {
    const definition = await loadDefinitionSummary(
      store,
      `runs/${status.runId}/authoring/${task.candidateId}/definition.json`,
    );
    const summary = reasonSummary(task.reason);
    const candidate: CandidateSummary = {
      ...task,
      stage: candidateStage(task),
      ...(summary ? { reasonSummary: summary } : {}),
      ...(definition ? { definition } : {}),
    };
    return candidate;
  });
  return {
    runId: status.runId,
    phase: status.phase,
    ...(status.requestedByDifficulty
      ? { requestedByDifficulty: status.requestedByDifficulty }
      : {}),
    candidates,
  };
}

async function loadDefinitionSummary(
  store: ArtifactStore,
  key: string,
): Promise<CandidateDefinitionSummary | undefined> {
  const cached = definitionCache.get(key);
  if (cached !== undefined) return cached ?? undefined;
  const bytes = await store.getByKey(key).catch(() => undefined);
  const summary = bytes ? summarizeDefinition(Buffer.from(bytes).toString("utf8")) : undefined;
  if (definitionCache.size >= MAX_CACHED_DEFINITIONS) {
    const oldest = definitionCache.keys().next().value;
    if (oldest !== undefined) definitionCache.delete(oldest);
  }
  if (summary || bytes) definitionCache.set(key, summary ?? null);
  return summary;
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
