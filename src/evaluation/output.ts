import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

/** The values of the worker's secret variables, to redact from anything it records. */
export function environmentSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name]) => /SECRET|TOKEN|PASSWORD|API_KEY/.test(name))
    .map(([, value]) => value ?? "")
    .filter(Boolean);
}

export function redactOutput(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    for (const variant of new Set([
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
    ])) {
      result = result.split(variant).join("[redacted]");
    }
  }
  return result
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[redacted]");
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
/** The verifier's scores in Harbor's trial result: its finite numbers only. */
export function verifierRewards(result: unknown): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record(record(record(result).verifier_result).rewards)).filter(
      (pair): pair is [string, number] => typeof pair[1] === "number" && Number.isFinite(pair[1]),
    ),
  );
}
/** Whether Harbor's trial result says it stopped the agent at its time limit. */
export function agentTimedOut(result: unknown): boolean {
  return record(record(result).exception_info).exception_type === "AgentTimeoutError";
}
export function completeLines(text: string): string {
  return text.slice(0, text.lastIndexOf("\n") + 1);
}
const TRIAL_LOG_CHARS = 100_000;
/** Keeps the last `limit` characters, starting on a whole line. */
function tailLines(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(-limit);
  const kept = cut.slice(cut.indexOf("\n") + 1);
  return `[${text.length - kept.length} earlier characters omitted]\n${kept}`;
}
/**
 * The readable trial log: Harbor's summary, the verifier's output, then Harbor's trial log.
 * Agent transcripts are left out (they are shown as steps), as is job.log when it only repeats a
 * trial log. Each section gets an equal share of the budget so none can evict the others.
 */
export function trialLog(stdout: string, files: ReadonlyMap<string, string>): string {
  const rank = (name: string) => {
    if (/\/verifier\/test-stdout\.txt$/.test(name)) return 1;
    if (/\/verifier\/[^/]+\.txt$/.test(name)) return 2;
    if (/(^|\/)trial\.log$/.test(name)) return 3;
    if (/(^|\/)job\.log$/.test(name)) return 4;
    return undefined;
  };
  const logs = [...files]
    .flatMap(([name, text]) => {
      const order = rank(name);
      return order === undefined ? [] : [{ order, name, text }];
    })
    .filter((file, _, all) => file.order !== 4 || !all.some((other) => other.order === 3))
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
  const sections = [...(stdout.trim() ? [{ name: "Harbor output", text: stdout }] : []), ...logs];
  const share = Math.floor(TRIAL_LOG_CHARS / Math.max(1, sections.length));
  return sections
    .map(({ name, text }) => `--- ${name} ---\n${tailLines(text.trimEnd(), share)}`)
    .join("\n\n");
}
/** The error Pi's run ended on, if its last reply failed rather than finishing. */
export function piFailure(text: string): string | undefined {
  let last: Record<string, unknown> | undefined;
  for (const line of text.split("\n")) {
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }
    const message = record(event.message);
    if (event.type === "message_end" && message.role === "assistant") last = message;
  }
  const reason = last?.stopReason;
  if (reason !== "error" && reason !== "aborted") return undefined;
  return typeof last?.errorMessage === "string" && last.errorMessage
    ? last.errorMessage.slice(0, 2000)
    : `Model request ${reason}`;
}
/** Prefixed to a log collectOutput cut to its last megabyte. */
export const TRUNCATED_OUTPUT = "[Earlier output truncated]\n";

export async function collectOutput(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let remaining = 4 * 1024 * 1024;
  const walk = async (directory: string, prefix: string, depth: number): Promise<void> => {
    if (depth > 3 || found.size >= 40 || remaining <= 0) return;
    const entries = (await readdir(directory, { withFileTypes: true }).catch(() => [])).sort(
      (left, right) => Number(right.name === "result.json") - Number(left.name === "result.json"),
    );
    for (const entry of entries) {
      if (remaining <= 0 || found.size >= 40) break;
      const path = join(directory, entry.name);
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory() && !(await lstat(path)).isSymbolicLink()) {
        await walk(path, `${name}/`, depth + 1);
      } else if (
        entry.isFile() &&
        /^(result\.json|trajectory\.json|pi\.txt|codex\.txt|claude-code\.txt|trial\.log|job\.log|test-stdout\.txt|test-stderr\.txt|reward\.txt|reward\.json)$/.test(
          entry.name,
        )
      ) {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
          () => undefined,
        );
        if (!file) continue;
        try {
          const stat = await file.stat();
          if (!stat.isFile()) continue;
          const size = Math.min(stat.size, 1024 * 1024, remaining);
          const buffer = Buffer.alloc(size);
          const offset = /\.(txt|log)$/.test(name) ? Math.max(0, stat.size - size) : 0;
          const { bytesRead } = await file.read(buffer, 0, size, offset);
          found.set(
            name,
            `${offset ? TRUNCATED_OUTPUT : ""}${buffer.subarray(0, bytesRead).toString("utf8")}`,
          );
          remaining -= bytesRead;
        } finally {
          await file.close();
        }
      }
    }
  };
  await walk(root, "", 0);
  return found;
}

/** Transcripts past this size keep only their collected part. */
const WHOLE_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

/**
 * The collected files with each Harbor trial's transcript read whole, for cost and failure checks.
 * collectOutput cuts long transcripts and can skip them once its budget is spent.
 */
export async function wholeTranscripts(
  root: string,
  files: Map<string, string>,
): Promise<Map<string, string>> {
  const whole = new Map(files);
  const trials = await readdir(join(root, "solver"), { withFileTypes: true }).catch(() => []);
  for (const trial of trials) {
    const agent = `solver/${trial.name}/agent`;
    if (
      !trial.isDirectory() ||
      !(await lstat(join(root, agent)).catch(() => undefined))?.isDirectory()
    )
      continue;
    for (const name of [`${agent}/pi.txt`, `${agent}/trajectory.json`]) {
      const file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(
        () => undefined,
      );
      if (!file) continue;
      try {
        const stat = await file.stat();
        if (stat.isFile() && stat.size <= WHOLE_TRANSCRIPT_BYTES)
          whole.set(name, await file.readFile("utf8"));
      } catch {
        // The collected part, if any, stands.
      } finally {
        await file.close();
      }
    }
  }
  return whole;
}
