import type { ModelPricing } from "../contracts/models.js";
import { isGateway } from "../gateways/index.js";
import { claudeCodeUsage, HOUR_CACHE_WRITE_MULTIPLIER } from "../harnesses/claude-code/cost.js";
import { codexCallUsage, harborCost } from "../harnesses/harbor/cost.js";
import { gatewayModel } from "./execution.js";
import { agentTimedOut, record, TRUNCATED_OUTPUT } from "./output.js";
import type { EvaluationRun, EvaluationTrial, Harness, TokenUsage } from "./types.js";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const OPENAI_MIN_CACHE_TOKENS = 1024;

/**
 * Codex ChatGPT sign-in never reports cache writes, so fresh input on a cacheable request reads
 * as plain input although the API bills it as a write. Like Dari's subscription usage adapter,
 * each such request's fresh input is attributed to writes and repriced at the saved rates.
 * "unchanged" leaves the measured usage alone; null means the records cannot support a cost.
 */
function inferSubscriptionWrites(
  trajectory: Record<string, unknown>,
  run: EvaluationRun,
  usage: TokenUsage,
): { usage: TokenUsage; costUsd: number } | "unchanged" | null {
  const pricing = run.pricing;
  // Without a write premium the buckets price identically.
  if (!pricing || pricing.cacheWrite <= pricing.input) return "unchanged";
  const calls = codexCallUsage(trajectory);
  if (!calls) return null;
  const original: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const inferred: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let changed = false;
  let costUsd = 0;
  for (const call of calls) {
    original.input += call.input;
    original.output += call.output;
    original.cacheRead += call.cacheRead;
    original.cacheWrite += call.cacheWrite;
    // The reference rates' context bound applies to each request, not the trial's sum.
    const promptTokens = call.input + call.cacheRead + call.cacheWrite;
    if (pricing.maxInputTokens && promptTokens > pricing.maxInputTokens) return null;
    let input = call.input;
    let cacheWrite = call.cacheWrite;
    // Prompts under OpenAI's cache minimum are never cached, so their fresh input stays input.
    if (cacheWrite === 0 && input > 0 && input + call.cacheRead >= OPENAI_MIN_CACHE_TOKENS) {
      cacheWrite = input;
      input = 0;
      changed = true;
    }
    inferred.input += input;
    inferred.output += call.output;
    inferred.cacheRead += call.cacheRead;
    inferred.cacheWrite += cacheWrite;
    costUsd +=
      (input * pricing.input +
        call.output * pricing.output +
        call.cacheRead * pricing.cacheRead +
        cacheWrite * pricing.cacheWrite) /
      1_000_000;
  }
  if (
    original.input !== usage.input ||
    original.output !== usage.output ||
    original.cacheRead !== usage.cacheRead ||
    original.cacheWrite !== usage.cacheWrite
  )
    return null;
  return changed ? { usage: inferred, costUsd } : "unchanged";
}

/**
 * Pi's assistant messages, or undefined when the stream cannot account for all of them. A stream
 * stored from its tail has lost its early message_end events, but its final agent_end lists every
 * message of that agent run. The run must start with the prompt: a retry's run starts with its
 * first reply, and the attempts before it are gone.
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
      // Only the notice and the line the cut went through may precede the first whole event.
      if (truncated && !events.length) continue;
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

/** `usage` at the reference rates, with `hourCacheWrite` of its cache writes kept for an hour. */
export function referenceCost(pricing: ModelPricing, usage: TokenUsage, hourCacheWrite = 0) {
  return (
    (usage.input * pricing.input +
      usage.output * pricing.output +
      usage.cacheRead * pricing.cacheRead +
      (usage.cacheWrite - hourCacheWrite) * pricing.cacheWrite +
      hourCacheWrite * pricing.input * HOUR_CACHE_WRITE_MULTIPLIER) /
    1_000_000
  );
}

export function trialCost(
  run: EvaluationRun,
  harness: Harness,
  files: Map<string, string>,
  result: unknown,
  auth = run.credentials?.auth,
): Pick<
  EvaluationTrial,
  "modelVerified" | "apiCostUsd" | "tokenUsage" | "costSource" | "cacheWritesInferred"
> {
  const pricing = run.pricing;
  const model = run.modelName.split("/").slice(1).join("/");
  // Harbor records the model name the runner passed it: the gateway form on a gateway route.
  const harborModel = gatewayModel(run.credentials?.provider, harness, run.modelName);
  const matches = (value: unknown) =>
    value === model || value === run.modelName || value === harborModel;
  let usage: TokenUsage | undefined;
  let verified = false;
  let reportedCost: number | undefined;
  let cacheWritesInferred = false;
  let largestPrompt: number | undefined;
  let hourCacheWrite = 0;
  if (harness === "pi") {
    const text = [...files].find(([name]) => name.endsWith("/pi.txt"))?.[1];
    if (!text) return {};
    const stopped = agentTimedOut(result);
    const messages = piAssistantMessages(text, stopped);
    if (!messages) return {};
    verified =
      messages.length > 0 &&
      messages.every((message) => `${message.provider}/${message.model}` === run.modelName);
    const totals: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    largestPrompt = 0;
    for (const message of messages) {
      const tokens = record(message.usage);
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        const value = tokens[key];
        if (!count(value)) return { modelVerified: verified };
        totals[key] += value;
      }
      largestPrompt = Math.max(
        largestPrompt,
        Number(tokens.input) + Number(tokens.cacheRead) + Number(tokens.cacheWrite),
      );
    }
    usage = totals;
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
        return { modelVerified: verified };
      usage = {
        input: tokens.n_input_tokens - tokens.n_cache_tokens,
        output: tokens.n_output_tokens,
        cacheRead: tokens.n_cache_tokens,
        cacheWrite: 0,
      };
    }
  } else if (harness === "codex") {
    const text = [...files].find(([name]) => name.endsWith("/trajectory.json"))?.[1];
    if (!text) return {};
    let trajectory: Record<string, unknown>;
    try {
      trajectory = record(JSON.parse(text));
    } catch {
      return {};
    }
    const steps = Array.isArray(trajectory.steps)
      ? trajectory.steps.map(record).filter((step) => step.source === "agent")
      : [];
    verified =
      steps.length > 0 &&
      steps.every((step) => matches(step.model_name ?? record(trajectory.agent).model_name));
    const tokens = record(record(result).agent_result);
    const cacheWrite =
      record(record(trajectory.final_metrics).extra).total_cache_write_input_tokens ?? 0;
    if (
      count(tokens.n_input_tokens) &&
      count(tokens.n_output_tokens) &&
      count(tokens.n_cache_tokens) &&
      count(cacheWrite) &&
      tokens.n_cache_tokens + cacheWrite <= tokens.n_input_tokens
    ) {
      const calls = codexCallUsage(trajectory);
      if (calls)
        largestPrompt = Math.max(
          0,
          ...calls.map((call) => call.input + call.cacheRead + call.cacheWrite),
        );
      usage = {
        input: tokens.n_input_tokens - tokens.n_cache_tokens - cacheWrite,
        output: tokens.n_output_tokens,
        cacheRead: tokens.n_cache_tokens,
        cacheWrite,
      };
      const inferred =
        auth === "codex-login" ? inferSubscriptionWrites(trajectory, run, usage) : "unchanged";
      if (inferred === null) return { modelVerified: verified, tokenUsage: usage };
      if (inferred === "unchanged") reportedCost = harborCost(trajectory, usage, tokens.cost_usd);
      else {
        usage = inferred.usage;
        reportedCost = inferred.costUsd;
        cacheWritesInferred = true;
      }
    }
  } else if (harness === "claude-code") {
    const text = [...files].find(([name]) => name.endsWith("/trajectory.json"))?.[1];
    if (!text) return {};
    let measured: ReturnType<typeof claudeCodeUsage>;
    try {
      measured = claudeCodeUsage(record(JSON.parse(text)), record(record(result).agent_result));
    } catch {
      return {};
    }
    if (!measured) return {};
    verified = measured.models.every(matches);
    usage = measured.usage;
    largestPrompt = measured.largestPrompt;
    hourCacheWrite = measured.hourCacheWrite;
  }
  const measured = {
    modelVerified: verified,
    ...(usage ? { tokenUsage: usage } : {}),
    ...(cacheWritesInferred ? { cacheWritesInferred: true } : {}),
  };
  if (!verified || !usage) return measured;
  const reported =
    reportedCost === undefined
      ? measured
      : {
          ...measured,
          apiCostUsd: reportedCost,
          costSource: cacheWritesInferred ? ("reference-rates" as const) : ("harbor" as const),
        };
  // Harbor prices a gateway route from LiteLLM's table for it, which may carry a discount or
  // another provider's rates; gateway runs are priced at their vendor's list rates (runPricing),
  // and Harbor's figure stands in only where those cannot price the trial.
  if (!pricing || (reportedCost !== undefined && !isGateway(run.credentials?.provider)))
    return reported;
  // The bound is per request; without per-request records the trial's total stands in for one.
  const prompt = largestPrompt ?? usage.input + usage.cacheRead + usage.cacheWrite;
  if (pricing.maxInputTokens && prompt > pricing.maxInputTokens) return reported;
  const apiCostUsd = referenceCost(pricing, usage, hourCacheWrite);
  return Number.isFinite(apiCostUsd)
    ? { ...measured, apiCostUsd, costSource: "reference-rates" }
    : reported;
}
