import { expect, test } from "bun:test";
import { createUsageStore } from "../src/db/usage.js";
import { generationCost } from "../src/generation/billing/cost-status.js";
import { costSnapshot, meteredSandboxExecutor } from "../src/generation/billing/metered-sandbox.js";
import { type StageUsage, withUsageLedger } from "../src/generation/billing/usage.js";
import { runOnlyExecutor } from "./support/sandbox-executor.js";

import { testDatabase } from "./support/site-fixture.js";

const emptyUsage = {
  settledStages: [],
  modelCostUsd: undefined,
  sandboxCostUsd: undefined,
  managedCostUsd: 0,
  modelTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  tokens: 0,
  sandboxSeconds: 0,
};

const now = "2026-01-01T00:00:00.000Z";

test("generation costs distinguish priced, partial, unpriced, and unknown providers", () => {
  expect(generationCost(emptyUsage, undefined, "gpt-6-sol")).toMatchObject({
    state: "unknown",
    sandboxSeconds: 0,
  });
  for (const provider of ["docker", "modal", "vercel"] as const) {
    expect(generationCost(emptyUsage, provider, "unknown-model")).toMatchObject({
      state: "unpriced",
    });
  }
  expect(
    generationCost(emptyUsage, "vercel", "gpt-6-sol", {
      stage: "author-candidate-r1",
      state: "partial",
      sandboxSeconds: 7,
      modelUsd: 0.02,
      updatedAt: now,
    }),
  ).toEqual({
    state: "partial",
    modelUsd: 0.02,
    sandboxSeconds: 7,
    updatedAt: now,
  });
  expect(
    generationCost(
      { ...emptyUsage, modelCostUsd: 0.03, sandboxCostUsd: 0.04, sandboxSeconds: 10 },
      "e2b",
      "gpt-6-sol",
      {
        stage: "author-candidate-r1",
        state: "estimated",
        sandboxSeconds: 5,
        sandboxUsd: 0.01,
        modelUsd: 0.02,
        updatedAt: now,
      },
    ),
  ).toEqual({
    state: "estimated",
    usd: 0.1,
    sandboxUsd: 0.05,
    modelUsd: 0.05,
    sandboxSeconds: 15,
    updatedAt: now,
  });
});

test("a settled stage excludes its heartbeat even when the heartbeat is newer", () => {
  const settled = {
    ...emptyUsage,
    settledStages: ["author-candidate-r1"],
    modelCostUsd: 0.03,
    sandboxCostUsd: 0.04,
    sandboxSeconds: 10,
  };
  const heartbeat = {
    stage: "author-candidate-r1",
    state: "estimated" as const,
    sandboxSeconds: 10,
    sandboxUsd: 0.04,
    modelUsd: 0.03,
    updatedAt: "2026-01-01T00:00:11.000Z",
  };
  const nextStage = {
    ...heartbeat,
    stage: "verify-candidate-r1",
    sandboxSeconds: 2,
    sandboxUsd: 0.01,
    modelUsd: 0.02,
  };
  expect(generationCost(settled, "e2b", "gpt-6-sol", [heartbeat, nextStage])).toEqual({
    state: "estimated",
    usd: 0.1,
    sandboxUsd: 0.05,
    modelUsd: 0.05,
    sandboxSeconds: 12,
    updatedAt: nextStage.updatedAt,
  });
});

test("a running sandbox's live cost is priced from its rates and the tokens it reported", () => {
  const sandbox = {
    sandboxId: "sandbox",
    stage: "author-candidate-r1",
    startedAt: new Date(10_000).toISOString(),
    expiresAt: new Date(3_600_000).toISOString(),
    cpu: 4,
    memoryMiB: 8192,
    rates: { model: "gpt-6-sol", sandboxProvider: "e2b" as const },
  };
  const usage = { input: 1_000, output: 500, cacheRead: 100, cacheWrite: 50, messages: 1 };

  const cost = costSnapshot(sandbox, usage, 70_000);

  expect(cost).toMatchObject({
    stage: "author-candidate-r1",
    state: "estimated",
    sandboxSeconds: 60,
  });
  expect(cost.sandboxUsd).toBeGreaterThan(0);
  expect(cost.modelUsd).toBeGreaterThan(0);
  expect(costSnapshot({ ...sandbox, rates: { sandboxProvider: "modal" } }, undefined).state).toBe(
    "unpriced",
  );
});

test("usage summaries enforce tenant and candidate stage boundaries", async () => {
  const database = await testDatabase();
  const usage = createUsageStore(database.db);
  const row = (orgId: number, stage: string, modelCostUsd: number) =>
    usage.record({
      runId: "shared-run",
      orgId,
      stage,
      managed: false,
      managedModel: false,
      managedSandbox: false,
      sandboxSeconds: 1,
      modelCostUsd,
    });
  try {
    await row(1, "author-c_1-r1", 1);
    await row(1, "verify-c_1-r2", 2);
    await row(1, "author-cX1-r1", 4);
    await row(2, "author-c_1-r1", 8);

    expect(await usage.summary("shared-run", 1, { candidateId: "c_1" })).toMatchObject({
      modelCostUsd: 3,
      sandboxSeconds: 2,
      settledStages: ["author-c_1-r1", "verify-c_1-r2"],
    });
    expect(await usage.summary("shared-run", 2, { candidateId: "c_1" })).toMatchObject({
      modelCostUsd: 8,
      sandboxSeconds: 1,
    });
  } finally {
    await database.close();
  }
});

test("a started sandbox is billed from start to stop", async () => {
  const stopped: string[] = [];
  const recorded: StageUsage[] = [];
  const executor = meteredSandboxExecutor(
    {
      ...runOnlyExecutor(async () => {
        throw new Error("not run");
      }),
      stop: async (sandbox) => {
        stopped.push(sandbox.sandboxId);
      },
    },
    {
      managedModel: true,
      managedSandbox: true,
      model: "gpt-6-sol",
      sandboxProvider: "e2b",
      provider: "openrouter",
    },
  );
  const startedAt = new Date(Date.now() - 90_000).toISOString();

  await withUsageLedger(
    async (usage) => {
      recorded.push(usage);
    },
    () =>
      executor.stop(
        {
          sandboxId: "sb",
          stage: "author-c",
          startedAt,
          expiresAt: startedAt,
          cpu: 4,
          memoryMiB: 8192,
        },
        { input: 1_000, output: 500, cacheRead: 100, cacheWrite: 50, messages: 1 },
      ),
  );

  expect(stopped).toEqual(["sb"]);
  expect(recorded).toEqual([
    expect.objectContaining({
      stage: "author-c",
      managedSandbox: true,
      sandboxSeconds: expect.any(Number),
      sandboxCostUsd: expect.any(Number),
      modelCostUsd: expect.any(Number),
      tokens: { input: 1_000, output: 500, cacheRead: 100, cacheWrite: 50 },
    }),
  ]);
  expect(recorded[0]?.sandboxSeconds).toBeGreaterThanOrEqual(90);
});
