import { expect, test } from "bun:test";
import { trialCost } from "../src/evaluation/cost.js";
import { initialEvaluation } from "../src/evaluation/store.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

const pricing = {
  input: 2,
  output: 8,
  cacheRead: 0.5,
  cacheWrite: 2.5,
  source: "https://provider.example/pricing",
  asOf: "2026-09-05",
};
test("Pi dollar totals cannot invent pricing for unknown models", () => {
  const run = initialEvaluation(evaluationInput(), "Test");
  const event = {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openai",
      model: "test-model",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 80,
        cacheWrite: 20,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
      },
    },
  };
  const files = () => new Map([["agent/pi.txt", JSON.stringify(event)]]);
  const result = { agent_result: { cost_usd: 0.37 } };
  // The run is verified and its tokens measured, so the missing cost is down to missing pricing.
  expect(trialCost(run, "pi", files(), result)).toEqual({
    modelVerified: true,
    tokenUsage: { input: 100, output: 50, cacheRead: 80, cacheWrite: 20 },
  });
});

test("Pi cache-write tokens are charged separately and truncated events fail closed", () => {
  const run = initialEvaluation({ ...evaluationInput(), pricing }, "Test");
  const event = JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      provider: "openai",
      model: "test-model",
      usage: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 },
    },
  });
  expect(trialCost(run, "pi", new Map([["solver/trial/agent/pi.txt", event]]), {})).toEqual({
    modelVerified: true,
    apiCostUsd: 0.0013,
    tokenUsage: { input: 100, output: 100, cacheRead: 100, cacheWrite: 100 },
    costSource: "reference-rates",
  });
  expect(
    trialCost(run, "pi", new Map([["solver/trial/agent/pi.txt", `${event}\n{"partial"`]]), {})
      .apiCostUsd,
  ).toBeUndefined();
});

test("Pi trials are bounded per request and priced from a stored tail's final agent_end", () => {
  const run = initialEvaluation(
    { ...evaluationInput(), pricing: { ...pricing, maxInputTokens: 1000 } },
    "Test",
  );
  const reply = (input: number) => ({
    role: "assistant",
    provider: "openai",
    model: "test-model",
    usage: { input, output: 10, cacheRead: 0, cacheWrite: 0 },
  });
  const replies = [reply(600), reply(700)];
  const stream = (...events: object[]) =>
    new Map([
      ["solver/trial/agent/pi.txt", events.map((event) => JSON.stringify(event)).join("\n")],
    ]);
  const tail = (...events: object[]) =>
    new Map(
      [...stream(...events)].map(([name, text]) => [
        name,
        `[Earlier output truncated]\n"}]},"usage":{"inp\n${text}`,
      ]),
    );
  const cost = (1300 * 2 + 20 * 8) / 1_000_000;
  // 1,300 prompt tokens over the trial, but no single request passes the 1,000-token bound.
  const whole = stream(...replies.map((message) => ({ type: "message_end", message })));
  expect(trialCost(run, "pi", whole, {}).apiCostUsd).toBeCloseTo(cost, 12);
  expect(
    trialCost(run, "pi", stream({ type: "message_end", message: reply(1001) }), {}).apiCostUsd,
  ).toBeUndefined();

  const end = (messages: object[], willRetry = false) => ({
    type: "agent_end",
    messages,
    willRetry,
  });
  const prompt = { role: "user", content: "Fix the bug" };
  // The cut dropped the first message_end, but the final agent_end still lists both replies.
  const cut = tail({ type: "message_end", message: replies[1] }, end([prompt, ...replies]));
  expect(trialCost(run, "pi", cut, {}).apiCostUsd).toBeCloseTo(cost, 12);
  // A retry's run omits the attempts before it, and a live stream has no final agent_end yet.
  expect(trialCost(run, "pi", tail(end(replies)), {}).apiCostUsd).toBeUndefined();
  expect(trialCost(run, "pi", tail(end([prompt, reply(1)], true)), {}).apiCostUsd).toBeUndefined();
  expect(
    trialCost(run, "pi", tail({ type: "message_end", message: replies[1] }), {}).apiCostUsd,
  ).toBeUndefined();
});
