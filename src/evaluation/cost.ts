import { isGateway } from "../gateways/index.js";
import { claudeCodeUsage } from "../harnesses/claude-code/cost.js";
import { codexCallUsage, harborCost } from "../harnesses/harbor/cost.js";
import { gatewayModel } from "./execution.js";
import { agentTimedOut, record, TRUNCATED_OUTPUT } from "./output.js";
import { type RequestUsage, requestsCost, sameUsage, sumUsage, wholeCost } from "./request-cost.js";
import type { EvaluationRun, EvaluationTrial, Harness, TokenUsage } from "./types.js";

const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const OPENAI_MIN_CACHE_TOKENS = 1024;

/**
 * Codex ChatGPT sign-in never reports cache writes, so fresh input on a cacheable request reads
 * as plain input although the API bills it as a write. Like Dari's subscription usage adapter,
 * each such request's fresh input is attributed to writes. Each request's usage as billed;
 * "unchanged" leaves the measured usage alone; null means the records cannot support a cost.
 */
function inferSubscriptionWrites(
  trajectory: Record<string, unknown>,
  run: EvaluationRun,
  usage: TokenUsage,
): TokenUsage[] | "unchanged" | null {
  const pricing = run.pricing;
  // Without a write premium the buckets price identically.
  if (!pricing || pricing.cacheWrite <= pricing.input) return "unchanged";
  const calls = codexCallUsage(trajectory);
  if (!calls || !sameUsage(sumUsage(calls), usage)) return null;
  let changed = false;
  const billed = calls.map((call) => {
    // Prompts under OpenAI's cache minimum are never cached, so their fresh input stays input.
    if (call.cacheWrite > 0 || call.input === 0) return call;
    if (call.input + call.cacheRead < OPENAI_MIN_CACHE_TOKENS) return call;
    changed = true;
    return { ...call, input: 0, cacheWrite: call.input };
  });
  return changed ? billed : "unchanged";
}

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
  /** Each request's usage, when the records give every request and they add up to `usage`. */
  let requests: readonly RequestUsage[] | undefined;
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
    const replies: TokenUsage[] = [];
    for (const message of messages) {
      const { input, output, cacheRead, cacheWrite } = record(message.usage);
      if (!count(input) || !count(output) || !count(cacheRead) || !count(cacheWrite))
        return { modelVerified: verified };
      replies.push({ input, output, cacheRead, cacheWrite });
    }
    const totals = sumUsage(replies);
    largestPrompt = Math.max(
      0,
      ...replies.map((reply) => reply.input + reply.cacheRead + reply.cacheWrite),
    );
    usage = totals;
    requests = replies;
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
      // The tail's replies are not every request, so its largest prompt stands in for them.
      requests = undefined;
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
      if (calls && sameUsage(sumUsage(calls), usage)) requests = calls;
      const billed =
        auth === "codex-login" ? inferSubscriptionWrites(trajectory, run, usage) : "unchanged";
      if (billed === null) return { modelVerified: verified, tokenUsage: usage };
      if (billed === "unchanged") reportedCost = harborCost(trajectory, usage, tokens.cost_usd);
      else {
        // Writes are inferred only on priced runs, and each request at its own rates.
        const inferred = pricing && requestsCost(pricing, billed);
        if (inferred === undefined) return { modelVerified: verified, tokenUsage: usage };
        usage = sumUsage(billed);
        requests = billed;
        reportedCost = inferred;
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
    requests = measured.requests;
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
  const apiCostUsd = requests
    ? requestsCost(pricing, requests)
    : wholeCost(pricing, usage, largestPrompt, hourCacheWrite);
  return apiCostUsd !== undefined && Number.isFinite(apiCostUsd)
    ? { ...measured, apiCostUsd, costSource: "reference-rates" }
    : reported;
}
