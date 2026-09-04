const PROGRESS_PATTERNS = [
  /^\s*[0-9a-f]{12}:?\s+(?:Downloading|Extracting|Verifying Checksum|Download complete|Pull complete|Waiting|Already exists|Pulling fs layer)/,
  /^#\d+\s+(?:sha256:|extracting|DONE|CACHED|resolve |transferring |\.\.\.)/,
  /^#\d+\s+\d+(?:\.\d+)?s?\s*$/,
  /^\s*\[[=> #-]*\]\s*[\d.]+\s*[kMG]?B\s*\/\s*[\d.]+\s*[kMG]?B/,
  /^\s*(?:Downloading|Extracting|Pulling|Pulled|Waiting)\b.*\b(?:\d+(?:\.\d+)?\s*[kMG]?B|\d+%)/,
  /^\s*[|/\\-]\s*(?:Progress|Resolving|Fetching|Packages|resolved|reused|downloaded|added)\b/,
  /^\s*Progress: resolved \d+/,
  /^\s*(?:npm|pnpm|yarn)\s+(?:WARN\s+deprecated|notice)\b/i,
  /^[\s.]*$/,
];
const ERROR_PATTERN =
  /\b(?:error|ERROR|failed|Failed|exit code|exited with|unhealthy|dependency failed|not found|No such|denied|Traceback|panic|FATAL)\b/;
export const COMPOSE_DIAGNOSTICS_MARKER = "SelfBench compose diagnostics";

export interface ExcerptOptions {
  readonly budgetBytes?: number;
  readonly context?: number;
  readonly tailLines?: number;
}

/** Drops Docker/BuildKit pull progress, package-manager spinners, and repeated blank lines. */
export function filterProgressNoise(raw: string): string[] {
  const kept: string[] = [];
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trimEnd();
    if (PROGRESS_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      if (trimmed === "" && kept.length > 0 && kept[kept.length - 1] !== "") {
        kept.push("");
      }
      continue;
    }
    kept.push(trimmed);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") {
    kept.pop();
  }
  return kept;
}

/**
 * The part of a log an agent can act on: error lines with context, the SelfBench compose
 * diagnostics block, then the last filtered lines, within a byte budget. Progress noise never
 * survives, so a build failure shows the failing step instead of "Pull complete".
 */
export function excerptLog(raw: string, options: ExcerptOptions = {}): string {
  const budget = options.budgetBytes ?? 6_000;
  const context = options.context ?? 3;
  const tailLines = options.tailLines ?? 40;
  const lines = filterProgressNoise(raw);
  if (lines.length === 0) {
    return "";
  }
  const sections: string[] = [];
  const errorIndexes = lines.flatMap((line, index) => (ERROR_PATTERN.test(line) ? [index] : []));
  if (errorIndexes.length > 0) {
    sections.push(
      `## Error lines (with ${context} lines of context)\n${ranges(lines, errorIndexes, context)}`,
    );
  }
  const marker = lines.findIndex((line) => line.includes(COMPOSE_DIAGNOSTICS_MARKER));
  if (marker >= 0) {
    const end = lines.findIndex((line, index) => index > marker && line === "");
    sections.push(lines.slice(marker, end >= 0 ? end : lines.length).join("\n"));
  }
  sections.push(
    `## Last ${Math.min(tailLines, lines.length)} lines\n${lines.slice(-tailLines).join("\n")}`,
  );
  return fit(sections, budget);
}

function ranges(lines: readonly string[], indexes: readonly number[], context: number): string {
  const blocks: string[] = [];
  let start = -1;
  let end = -1;
  const flush = (): void => {
    if (start >= 0) {
      blocks.push(lines.slice(start, end + 1).join("\n"));
    }
  };
  for (const index of indexes) {
    const from = Math.max(0, index - context);
    const to = Math.min(lines.length - 1, index + context);
    if (start >= 0 && from <= end + 1) {
      end = Math.max(end, to);
    } else {
      flush();
      start = from;
      end = to;
    }
  }
  flush();
  return blocks.join("\n…\n");
}

function fit(sections: readonly string[], budget: number): string {
  const text = sections.join("\n\n");
  if (Buffer.byteLength(text) <= budget) {
    return text;
  }
  // Keep the earlier (higher-priority) sections whole; trim the tail section, then the rest.
  let remaining = budget;
  const kept: string[] = [];
  for (const section of sections) {
    const size = Buffer.byteLength(section) + 2;
    if (size <= remaining) {
      kept.push(section);
      remaining -= size;
    } else if (remaining > 200) {
      const buffer = Buffer.from(section);
      kept.push(
        `${buffer.subarray(0, remaining - 40).toString("utf8")}\n[truncated ${buffer.length - remaining + 40} bytes]`,
      );
      remaining = 0;
    }
  }
  return kept.join("\n\n");
}
