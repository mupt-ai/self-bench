import { agentTimedOut, record, TRUNCATED_OUTPUT } from "./output.js";
import type { RequestUsage } from "./request-cost.js";
import type { EvaluationRun, TokenUsage } from "./types.js";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Pi's assistant messages, or undefined when the stream cannot account for all of them. A stream
 * stored from its tail has lost its early message_end events, but its final agent_end lists every
 * message of that agent run. The run must start with the prompt: a retry's run starts with its
 * first reply, and the attempts before it are gone. Pi prints its notices, such as using a model
 * it does not list under the id it was given, ahead of the stream.
 *
 * A Pi stopped at its time limit never writes its agent_end, and its last line is usually cut
 * where its output stopped, so every whole message_end of its stream counts. A stored tail's
 * replies then only vouch for the model; trialCost takes the totals from Harbor.
 */
function piAssistantMessages(
  text: string,
  stopped: boolean,
): Record<string, unknown>[] | undefined {
  const truncated = text.startsWith(TRUNCATED_OUTPUT);
  const events: Record<string, unknown>[] = [];
  const lines = text.split("\n").filter(Boolean);
  for (const [index, line] of lines.entries()) {
    try {
      events.push(record(JSON.parse(line)));
    } catch {
      // Pi's notices, or a stored tail's notice and the line the cut went through, come before
      // the first whole event.
      if (!events.length) continue;
      if (!(stopped && index === lines.length - 1)) return undefined;
    }
  }
  if (!truncated || stopped)
    return events
      .filter((event) => event.type === "message_end")
      .map((event) => record(event.message))
      .filter((message) => message.role === "assistant");
  const ends = events.filter((event) => event.type === "agent_end");
  const [end] = ends;
  if (ends.length !== 1 || !end || end.willRetry || !Array.isArray(end.messages)) return undefined;
  const messages = end.messages.map(record);
  if (messages.find((message) => message.role !== "system")?.role !== "user") return undefined;
  return messages.filter((message) => message.role === "assistant");
}

export interface PiCostMeasurement {
  modelVerified: boolean;
  tokenUsage?: TokenUsage;
  requests?: readonly RequestUsage[];
  largestPrompt?: number;
}

export function measurePiCost(
  run: EvaluationRun,
  files: Map<string, string>,
  result: unknown,
  endpointModels: readonly string[],
): PiCostMeasurement | undefined {
  const text = [...files].find(([name]) => name.endsWith("/pi.txt"))?.[1];
  if (!text) return undefined;
  const stopped = agentTimedOut(result);
  const messages = piAssistantMessages(text, stopped);
  if (!messages) return undefined;
  const modelVerified =
    messages.length > 0 &&
    messages.every((message) =>
      [run.modelName, ...endpointModels].includes(`${message.provider}/${message.model}`),
    );
  const replies: TokenUsage[] = [];
  for (const message of messages) {
    const { input, output, cacheRead, cacheWrite } = record(message.usage);
    if (!count(input) || !count(output) || !count(cacheRead) || !count(cacheWrite))
      return { modelVerified };
    replies.push({ input, output, cacheRead, cacheWrite });
  }
  const totals = {
    input: replies.reduce((sum, reply) => sum + reply.input, 0),
    output: replies.reduce((sum, reply) => sum + reply.output, 0),
    cacheRead: replies.reduce((sum, reply) => sum + reply.cacheRead, 0),
    cacheWrite: replies.reduce((sum, reply) => sum + reply.cacheWrite, 0),
  };
  let tokenUsage = totals;
  let requests: readonly RequestUsage[] | undefined = replies;
  const largestPrompt = Math.max(
    0,
    ...replies.map((reply) => reply.input + reply.cacheRead + reply.cacheWrite),
  );
  if (stopped && text.startsWith(TRUNCATED_OUTPUT)) {
    // Harbor summed the whole stream's replies, but without cache writes: it stands in only
    // when the tail's replies wrote none.
    const tokens = record(record(result).agent_result);
    if (
      totals.cacheWrite > 0 ||
      !count(tokens.n_input_tokens) ||
      !count(tokens.n_output_tokens) ||
      !count(tokens.n_cache_tokens) ||
      tokens.n_cache_tokens > tokens.n_input_tokens
    )
      return { modelVerified };
    tokenUsage = {
      input: tokens.n_input_tokens - tokens.n_cache_tokens,
      output: tokens.n_output_tokens,
      cacheRead: tokens.n_cache_tokens,
      cacheWrite: 0,
    };
    // The tail's replies are not every request, so its largest prompt stands in for them.
    requests = undefined;
  }
  return {
    modelVerified,
    tokenUsage,
    ...(requests ? { requests } : {}),
    ...(largestPrompt === undefined ? {} : { largestPrompt }),
  };
}
