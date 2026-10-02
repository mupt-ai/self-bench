import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { recomputeEvaluationCost } from "../src/evaluation/recompute-cost.js";
import {
  evaluationPrefix,
  getEvaluation,
  initialEvaluation,
  saveEvaluation,
} from "../src/evaluation/store.js";
import { gatewayIds, setGatewayListing } from "../src/gateways/index.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
  for (const gateway of gatewayIds) setGatewayListing(gateway, { models: [], rates: new Map() });
});

test("recompute prices requests past a flat 200k bound the model's pricing never had", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-recompute-"));
  directories.push(directory);
  const store = new LocalArtifactStore(directory);
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      model: "claude-opus-5-5",
      modelName: "anthropic/claude-opus-5-5",
      harnesses: ["pi"],
      pricing: {
        input: 4,
        output: 20,
        cacheRead: 0.2,
        cacheWrite: 5,
        source: "https://platform.claude.com/docs/en/about-claude/pricing",
        asOf: "2026-09-23",
        maxInputTokens: 200_000,
      },
      credentials: {
        modelCredentialId: "model",
        sandboxCredentialId: "sandbox",
        provider: "anthropic",
        auth: "api-key",
      },
    },
    "Test",
  );
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing trial");
  run.status = "completed";
  const usage = { input: 50_000, output: 1_000, cacheRead: 200_000, cacheWrite: 0 };
  // The 250k-token request passed the bound, so the runner recorded the usage but no cost.
  Object.assign(trial, { status: "completed", modelVerified: true, tokenUsage: usage });
  const message = { role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage };
  const whole = JSON.stringify({ type: "message_end", message });
  const piName = "0/solver/task__1/agent/pi.txt";
  for (const [name, body] of [
    [piName, whole],
    ["0/solver/task__1/result.json", "{}"],
  ] as const) {
    trial.artifacts.push(name);
    await store.put(
      `${evaluationPrefix(run.repoId, run.id)}artifacts/${name}`,
      Buffer.from(body),
      "text/plain",
    );
  }
  await saveEvaluation(store, run);

  const cost = (50_000 * 4 + 1_000 * 20 + 200_000 * 0.2) / 1e6;
  const dry = await recomputeEvaluationCost(store, run.repoId, run.id, false);
  // One rate covers Opus 5.5's whole context window, so the request has a price.
  expect(dry.maxInputTokens).toEqual({ before: 200_000, after: undefined, changed: true });
  expect(dry.trials[0]?.after?.apiCostUsd).toBeCloseTo(cost, 12);

  // A stored transcript cut too far to count again is priced from the recorded usage.
  await writeFile(
    join(directory, evaluationPrefix(run.repoId, run.id), "artifacts", piName),
    `[Earlier output truncated]\n${whole.slice(40)}`,
  );
  expect((await recomputeEvaluationCost(store, run.repoId, run.id, true)).applied).toBe(true);
  const saved = await getEvaluation(store, run.repoId, run.id);
  expect(saved?.pricing).toMatchObject({ input: 4, cacheRead: 0.2 });
  expect(saved?.pricing?.maxInputTokens).toBeUndefined();
  expect(saved?.trials[0]).toMatchObject({ costSource: "reference-rates", tokenUsage: usage });
  expect(saved?.trials[0]?.apiCostUsd).toBeCloseTo(cost, 12);
});

test("recompute prices a cut Claude Code trial by the cache lifetimes Claude Code's own cost implies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-recompute-"));
  directories.push(directory);
  const store = new LocalArtifactStore(directory);
  const usage = { input: 200, output: 100_000, cacheRead: 20_000_000, cacheWrite: 300_000 };
  // At Opus 5.5's rates with every cache write kept for an hour (twice the input rate).
  const hourly = (200 * 4 + 100_000 * 20 + 20_000_000 * 0.2 + 300_000 * 8) / 1e6;
  const recompute = async (reported: number, stream = true) => {
    const run = initialEvaluation(
      {
        ...evaluationInput(),
        model: "claude-opus-5-5",
        modelName: "anthropic/claude-opus-5-5",
        harnesses: ["claude-code"],
        pricing: {
          input: 4,
          output: 20,
          cacheRead: 0.2,
          cacheWrite: 5,
          source: "https://platform.claude.com/docs/en/about-claude/pricing",
          asOf: "2026-09-23",
          maxInputTokens: 200_000,
        },
        credentials: {
          modelCredentialId: "model",
          sandboxCredentialId: "sandbox",
          provider: "anthropic",
          auth: "claude-login",
        },
      },
      "Test",
    );
    const trial = run.trials[0];
    if (!trial) throw new Error("Missing trial");
    run.status = "completed";
    Object.assign(trial, { status: "completed", modelVerified: true, tokenUsage: usage });
    // Claude Code ends its stream with the cost it computed; Harbor copies it into its result.
    const result = JSON.stringify({ type: "result", total_cost_usd: reported });
    for (const [name, body] of [
      // Stored from its head and cut, so it no longer parses.
      ["0/solver/task__1/agent/trajectory.json", '{"steps":[{"source":"agent","metrics":{'],
      ["0/solver/task__1/agent/claude-code.txt", stream ? `{"type":"assistant"}\n${result}\n` : ""],
      ["0/solver/task__1/result.json", JSON.stringify({ agent_result: { cost_usd: reported } })],
    ] as const) {
      trial.artifacts.push(name);
      await store.put(
        `${evaluationPrefix(run.repoId, run.id)}artifacts/${name}`,
        Buffer.from(body),
        "text/plain",
      );
    }
    await saveEvaluation(store, run);
    return (await recomputeEvaluationCost(store, run.repoId, run.id, false)).trials[0];
  };
  expect((await recompute(hourly))?.after?.apiCostUsd).toBeCloseTo(hourly, 9);
  // 100,000 of the writes kept for five minutes, at $5 rather than $8 per million.
  const mixed = hourly - 0.3;
  expect((await recompute(mixed))?.after?.apiCostUsd).toBeCloseTo(mixed, 9);
  // No whole number of hour-long writes explains this cost, so the trial stays unpriced.
  expect((await recompute(hourly - 0.5))?.changed).toBe(false);
  // Without Claude Code's own figure, Harbor's may be its estimate at five-minute rates.
  expect((await recompute(hourly, false))?.changed).toBe(false);
});

test("recompute drops a cut trial's cost when the run's bound tightens past what priced it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-recompute-"));
  directories.push(directory);
  const store = new LocalArtifactStore(directory);
  // The gateway now prices prompts from 32,001 tokens at a higher tier.
  setGatewayListing("vercel-ai-gateway", {
    models: [],
    rates: new Map([
      ["vendor/tiered", { rates: [1, 2, 0.1, 1], asOf: "2026-10-02", longContextFrom: 32_001 }],
    ]),
  });
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      model: "vendor/tiered",
      modelName: "vercel-ai-gateway/vendor/tiered",
      harnesses: ["pi"],
      pricing: {
        ...{ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
        ...{ source: "https://vercel.com/ai-gateway/models/tiered", asOf: "2026-09-30" },
        maxInputTokens: 200_000,
      },
      credentials: {
        modelCredentialId: "model",
        sandboxCredentialId: "sandbox",
        provider: "vercel-ai-gateway",
        auth: "api-key",
      },
    },
    "Test",
  );
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing trial");
  run.status = "completed";
  const usage = { input: 100_000, output: 1_000, cacheRead: 0, cacheWrite: 0 };
  Object.assign(trial, {
    ...{ status: "completed", modelVerified: true, tokenUsage: usage },
    ...{ apiCostUsd: 0.102, costSource: "reference-rates" },
  });
  for (const [name, body] of [
    // A tail whose final agent_end was cut away, so its requests cannot be sized again.
    ["0/solver/task__1/agent/pi.txt", '[Earlier output truncated]\n{"type":"turn_end"}\n'],
    ["0/solver/task__1/result.json", "{}"],
  ] as const) {
    trial.artifacts.push(name);
    await store.put(
      `${evaluationPrefix(run.repoId, run.id)}artifacts/${name}`,
      Buffer.from(body),
      "text/plain",
    );
  }
  await saveEvaluation(store, run);
  const report = await recomputeEvaluationCost(store, run.repoId, run.id, false);
  expect(report.maxInputTokens).toEqual({ before: 200_000, after: 32_000, changed: true });
  expect(report.trials[0]?.after).toEqual({ modelVerified: true, tokenUsage: usage });
});
