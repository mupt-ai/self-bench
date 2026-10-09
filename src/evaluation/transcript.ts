import { record } from "./output.js";
import type { SolverStep } from "./types.js";

/**
 * A solver's transcript as steps: Harbor's ATIF trajectory.json (Codex, Claude Code, and the
 * other installed agents) or Pi's event log, pi.txt.
 */

/** Steps a trial's record keeps: the latest, when a transcript has more. */
const MAX_STEPS = 500;
/** Tool calls a step keeps. */
const MAX_TOOLS = 30;
/**
 * Characters a trial's steps may hold in its record, which every save of the run rewrites whole.
 * What the solver said and did (its messages and tool inputs, edits included) may take most of
 * it; the tools' output shares the rest.
 */
const STEPS_BUDGET = 200_000;
const SAID_AND_DONE_SHARE = 0.6;

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

/**
 * The largest length each text may keep so that together they fit `budget`, sharing it evenly:
 * a text shorter than its share keeps all of it, and leaves the rest to the longer ones.
 */
function fairShare(lengths: readonly number[], budget: number): number {
  const sorted = [...lengths].sort((left, right) => left - right);
  let left = budget;
  for (const [index, length] of sorted.entries()) {
    const share = Math.floor(left / (sorted.length - index));
    if (length > share) return Math.max(0, share);
    left -= length;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * `text` within `limit` characters: its start and its end, with a note of what the middle was.
 * A limit too small for the note keeps only the start, so the result never exceeds `limit`.
 */
function clipped(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const note = `\n[… ${text.length - limit} characters omitted …]\n`;
  if (limit < note.length * 2) return text.slice(0, Math.max(0, limit));
  const kept = limit - note.length;
  const head = Math.ceil(kept / 2);
  return `${text.slice(0, head)}${note}${text.slice(text.length - (kept - head))}`;
}

/**
 * Every step of a transcript, within the record's budget. Long texts are cut in the middle, not
 * dropped, so the whole run stays readable: messages and tool inputs first, then tool output.
 */
export function boundedSteps(steps: SolverStep[]): SolverStep[] {
  const kept = steps
    .slice(-MAX_STEPS)
    .map((step) => ({ ...step, tools: step.tools.slice(0, MAX_TOOLS) }));
  const said = kept.flatMap((step) => [step.text, ...step.tools.map((tool) => tool.input)]);
  const saidLimit = fairShare(
    said.map((text) => text.length),
    STEPS_BUDGET * SAID_AND_DONE_SHARE,
  );
  const saidUsed = said.reduce((total, text) => total + Math.min(text.length, saidLimit), 0);
  const outputLimit = fairShare(
    kept.flatMap((step) => step.tools.map((tool) => tool.output.length)),
    STEPS_BUDGET - saidUsed,
  );
  return kept
    .map((step) => ({
      ...step,
      text: clipped(step.text, saidLimit),
      tools: step.tools.map((tool) => ({
        ...tool,
        input: clipped(tool.input, saidLimit),
        output: clipped(tool.output, outputLimit),
      })),
    }))
    .filter((step) => step.text || step.tools.some((tool) => tool.input || tool.output));
}

export function trajectorySteps(value: unknown): SolverStep[] {
  const steps = record(value).steps;
  if (!Array.isArray(steps)) return [];
  return steps.slice(-MAX_STEPS).map((raw) => {
    const step = record(raw);
    const observations = record(step.observation).results;
    const results = Array.isArray(observations) ? observations.map(record) : [];
    return {
      id: String(step.step_id),
      role: String(step.source ?? "agent"),
      text: display(step.message),
      tools: (Array.isArray(step.tool_calls) ? step.tool_calls : []).map((rawTool) => {
        const tool = record(rawTool);
        return {
          id: String(tool.tool_call_id),
          name: String(tool.function_name ?? "tool"),
          input: display(tool.arguments),
          output: results
            .filter((result) => result.source_call_id === tool.tool_call_id)
            .map((result) => display(result.content))
            .join("\n"),
        };
      }),
    };
  });
}

/** Steps from Pi's messages, in order: each reply with its tool calls, each result on its call. */
function piMessageSteps(messages: readonly Record<string, unknown>[]): SolverStep[] {
  const steps: SolverStep[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "toolResult") {
      const tool = steps
        .flatMap((step) => step.tools)
        .reverse()
        .find((candidate) => candidate.id === message.toolCallId);
      if (tool) tool.output = display(message.content);
      continue;
    }
    if (message.role === "system") continue;
    const content = Array.isArray(message.content) ? message.content.map(record) : [];
    steps.push({
      id: String(message.timestamp ?? index),
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
  return steps;
}

/**
 * Pi's steps from its event log: its `message_end` events, or the conversation its last
 * `agent_end` repeats when that holds more. The repeat recovers a run whose log was kept only
 * from its end; the events win when Pi retried, since each attempt ends with its own `agent_end`
 * and a retry's leaves out the attempts before it (see cost.ts).
 */
export function piSteps(text: string): SolverStep[] {
  const ended: Record<string, unknown>[] = [];
  let whole: unknown[] = [];
  for (const line of text.split("\n")) {
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      continue;
    }
    if (event.type === "agent_end" && Array.isArray(event.messages)) whole = event.messages;
    if (event.type === "message_end") ended.push(record(event.message));
  }
  const messages = whole.length > ended.length ? whole.map(record) : ended;
  return piMessageSteps(messages).slice(-MAX_STEPS);
}

/**
 * The steps of the transcript among a trial's files, by file name, within the record's budget;
 * undefined when there is none. A trajectory that does not parse, as one cut short, gives none.
 */
export function transcriptSteps(files: ReadonlyMap<string, string>): SolverStep[] | undefined {
  const all = [...files];
  const trajectory = all.find(([name]) => name.endsWith("/trajectory.json"));
  const pi = all.find(([name]) => name.endsWith("/pi.txt"));
  if (trajectory) {
    try {
      return boundedSteps(trajectorySteps(JSON.parse(trajectory[1])));
    } catch {
      return [];
    }
  }
  return pi ? boundedSteps(piSteps(pi[1])) : undefined;
}
