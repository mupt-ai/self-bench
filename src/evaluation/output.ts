import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SolverStep } from "./types.js";

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
function display(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((part) =>
        typeof part === "string" ? part : display(record(part).text ?? record(part).content),
      )
      .filter(Boolean)
      .join("\n");
  return JSON.stringify(value, null, 2);
}
export function completeLines(text: string): string {
  return text.slice(0, text.lastIndexOf("\n") + 1);
}
export function boundedSteps(steps: SolverStep[]): SolverStep[] {
  let budget = 100_000;
  return steps
    .slice(-200)
    .reverse()
    .map((step) => {
      const bounded = (text: string) => {
        const value = text.slice(0, Math.max(0, budget));
        budget -= value.length;
        return value;
      };
      return {
        ...step,
        text: bounded(step.text),
        tools: step.tools
          .slice(0, 30)
          .map((tool) => ({ ...tool, input: bounded(tool.input), output: bounded(tool.output) })),
      };
    })
    .reverse()
    .filter((step) => step.text || step.tools.some((tool) => tool.input || tool.output));
}
export function trajectorySteps(value: unknown): SolverStep[] {
  const steps = record(value).steps;
  if (!Array.isArray(steps)) return [];
  return steps.slice(-500).map((raw) => {
    const step = record(raw);
    const observations = record(step.observation).results;
    const results = Array.isArray(observations) ? observations.map(record) : [];
    return {
      id: String(step.step_id),
      role: String(step.source ?? "agent"),
      text: display(step.message).slice(0, 20_000),
      tools: (Array.isArray(step.tool_calls) ? step.tool_calls : []).map((rawTool) => {
        const tool = record(rawTool);
        return {
          id: String(tool.tool_call_id),
          name: String(tool.function_name ?? "tool"),
          input: display(tool.arguments).slice(0, 20_000),
          output: results
            .filter((result) => result.source_call_id === tool.tool_call_id)
            .map((result) => display(result.content))
            .join("\n")
            .slice(0, 30_000),
        };
      }),
    };
  });
}
export function piSteps(text: string): SolverStep[] {
  const steps: SolverStep[] = [];
  for (const line of text.split("\n")) {
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (event.type !== "message_end") continue;
    const message = record(event.message);
    if (message.role === "toolResult") {
      const tool = steps
        .flatMap((step) => step.tools)
        .reverse()
        .find((candidate) => candidate.id === message.toolCallId);
      if (tool) tool.output = display(message.content).slice(0, 30_000);
      continue;
    }
    const content = Array.isArray(message.content) ? message.content.map(record) : [];
    steps.push({
      id: String(message.timestamp ?? steps.length),
      role: String(message.role ?? "agent"),
      text: content
        .filter((part) => part.type === "text")
        .map((part) => display(part.text))
        .join("\n"),
      tools: content
        .filter((part) => part.type === "toolCall")
        .map((part) => ({
          id: String(part.id),
          name: String(part.name ?? "tool"),
          input: display(part.arguments),
          output: "",
        })),
    });
  }
  return steps.slice(-500);
}

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
            `${offset ? "[Earlier output truncated]\n" : ""}${buffer.subarray(0, bytesRead).toString("utf8")}`,
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
