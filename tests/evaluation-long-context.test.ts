import { expect, test } from "bun:test";
import { findModel, nativePricing } from "../src/contracts/models.js";
import { trialCost } from "../src/evaluation/cost.js";
import { generationIds } from "../src/evaluation/gateway-cost.js";
import { initialEvaluation } from "../src/evaluation/store.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

/** The catalog's own pricing for `id` on its vendor's key, long-context tiers included. */
function vendorRun(id: string, auth: "api-key" | "claude-login" | "codex-login") {
  const model = findModel(id);
  const pricing = model && nativePricing(model);
  if (!model?.vendor || !pricing) throw new Error(`Missing ${id}`);
  const input: EvaluationInput = {
    ...evaluationInput(),
    model: id,
    modelName: `${model.vendor}/${id}`,
    pricing,
    credentials: {
      modelCredentialId: "model",
      sandboxCredentialId: "sandbox",
      provider: model.vendor,
      auth,
    },
  };
  return initialEvaluation(input, model.label);
}

test("each Claude Code request is billed at the tier its prompt reaches", () => {
  const run = vendorRun("claude-haiku-5-5", "claude-login");
  // Harbor's steps for two requests, every write cached for an hour as Claude sign-ins ask.
  const step = (cached: number, written: number, output: number) => ({
    source: "agent",
    model_name: "claude-haiku-5-5",
    metrics: {
      prompt_tokens: 2 + cached + written,
      completion_tokens: output,
      cached_tokens: cached,
      extra: {
        cache_creation_input_tokens: written,
        cache_creation: { ephemeral_1h_input_tokens: written, ephemeral_5m_input_tokens: 0 },
      },
    },
  });
  const steps = [step(50_000, 9_998, 300), step(140_000, 9_998, 500)];
  const files = new Map([["solver/t/agent/trajectory.json", JSON.stringify({ steps })]]);
  const result = {
    agent_result: { n_input_tokens: 210_000, n_cache_tokens: 190_000, n_output_tokens: 800 },
  };
  // 60k tokens at Haiku 5.5's list rates; 150k at its rates past 100k, five times higher. An
  // hour-long write costs twice the input rate of its request's tier.
  const short = 2 * 0.1 + 300 * 0.5 + 50_000 * 0.01 + 9_998 * 0.1 * 2;
  const long = 2 * 0.5 + 500 * 2.5 + 140_000 * 0.05 + 9_998 * 0.5 * 2;
  const cost = trialCost(run, "claude-code", files, result);
  expect(cost).toMatchObject({ modelVerified: true, costSource: "reference-rates" });
  expect(cost.apiCostUsd).toBeCloseTo((short + long) / 1_000_000, 12);

  // A run recorded with a bound and no tiers still leaves a request past it unpriced.
  const { longContext: _tiers, ...base } = run.pricing ?? {};
  const bounded = { ...run, pricing: { ...base, maxInputTokens: 100_000 } };
  expect(trialCost(bounded as typeof run, "claude-code", files, result).apiCostUsd).toBeUndefined();
});

test("Pi's notice ahead of its stream leaves its replies priced, each at its own tier", () => {
  const run = vendorRun("claude-haiku-5-5", "api-key");
  const reply = (input: number, output: number, cacheRead: number, cacheWrite: number) =>
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-haiku-5-5",
        responseId: `gen_${cacheRead}`,
        usage: { input, output, cacheRead, cacheWrite },
      },
    });
  // Pi names a model its catalog lacks on stderr, which Harbor writes into pi.txt first.
  const notice =
    'Warning: Model "claude-haiku-5-5" not found for provider "anthropic". Using custom model id.';
  const stream = [
    '{"type":"session"}',
    reply(2_000, 100, 50_000, 1_000),
    reply(3_000, 200, 120_000, 2_000),
  ];
  const files = (lines: string[]) => new Map([["solver/t/agent/pi.txt", lines.join("\n")]]);
  const short = 2_000 * 0.1 + 100 * 0.5 + 50_000 * 0.01 + 1_000 * 0.125;
  const long = 3_000 * 0.5 + 200 * 2.5 + 120_000 * 0.05 + 2_000 * 0.625;
  const priced = trialCost(run, "pi", files([notice, ...stream]), {});
  expect(priced).toMatchObject({
    modelVerified: true,
    tokenUsage: { input: 5_000, output: 300, cacheRead: 170_000, cacheWrite: 3_000 },
    costSource: "reference-rates",
  });
  expect(priced.apiCostUsd).toBeCloseTo((short + long) / 1_000_000, 12);
  expect(trialCost(run, "pi", files(stream), {})).toEqual(priced);
  // A gateway's bill is matched by the same replies.
  expect(generationIds("pi", files([notice, ...stream]))).toEqual(["gen_50000", "gen_120000"]);
  // A line that is not an event inside the stream still fails closed.
  expect(trialCost(run, "pi", files([...stream, notice, reply(1, 1, 1, 1)]), {})).toEqual({});
});

test("a stored tail prices whole only within the base rates", () => {
  const run = vendorRun("claude-haiku-5-5", "api-key");
  // Stopped at its time limit, the tail's replies only size the requests Harbor summed.
  const tail = (cacheRead: number) =>
    new Map([
      [
        "solver/t/agent/pi.txt",
        `[Earlier output truncated]\n"usage":{"inp\n${JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-haiku-5-5",
            usage: { input: 10, output: 10, cacheRead, cacheWrite: 0 },
          },
        })}`,
      ],
    ]);
  const stopped = {
    exception_info: { exception_type: "AgentTimeoutError" },
    agent_result: { n_input_tokens: 300_000, n_cache_tokens: 290_000, n_output_tokens: 100 },
  };
  expect(trialCost(run, "pi", tail(90_000), stopped).apiCostUsd).toBeCloseTo(
    (10_000 * 0.1 + 100 * 0.5 + 290_000 * 0.01) / 1_000_000,
    12,
  );
  // Past the first tier, the requests Harbor summed could be in either.
  expect(trialCost(run, "pi", tail(100_000), stopped).apiCostUsd).toBeUndefined();
});

test("Codex sign-in infers each request's writes and bills it at its own tier", () => {
  const run = vendorRun("gpt-6-sol", "codex-login");
  const call = (prompt: number, cached: number) => ({
    source: "agent",
    model_name: "gpt-6-sol",
    metrics: {
      prompt_tokens: prompt,
      completion_tokens: 500,
      cached_tokens: cached,
      extra: { cache_write_input_tokens: 0 },
    },
  });
  const trajectory = { steps: [call(100_000, 90_000), call(300_000, 290_000)] };
  const files = new Map([["solver/t/agent/trajectory.json", JSON.stringify(trajectory)]]);
  const result = {
    agent_result: { n_input_tokens: 400_000, n_cache_tokens: 380_000, n_output_tokens: 1_000 },
  };
  // Each request's 10,000 fresh tokens are writes; the second's prompt passes 272k, where
  // OpenAI doubles input and cache prices and charges half again for output.
  const short = 10_000 * 2.5 + 90_000 * 0.2 + 500 * 10;
  const long = 10_000 * 5 + 290_000 * 0.4 + 500 * 15;
  const cost = trialCost(run, "codex", files, result);
  expect(cost).toMatchObject({
    tokenUsage: { input: 0, output: 1_000, cacheRead: 380_000, cacheWrite: 20_000 },
    cacheWritesInferred: true,
    costSource: "reference-rates",
  });
  expect(cost.apiCostUsd).toBeCloseTo((short + long) / 1_000_000, 12);
});
