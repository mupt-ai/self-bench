import { expect, test } from "bun:test";
import { createUsageStore } from "../src/db/usage.js";
import { generationCost } from "../src/generation/billing/cost-status.js";
import { meteredSandboxExecutor } from "../src/generation/billing/metered-sandbox.js";
import { type StageUsage, withUsageLedger } from "../src/generation/billing/usage.js";
import type {
  SandboxCostSnapshot,
  SandboxExecutor,
  SandboxRunOptions,
} from "../src/sandbox/contracts.js";
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
  expect(generationCost(emptyUsage, undefined, "gpt-5.6-sol")).toMatchObject({
    state: "unknown",
    sandboxSeconds: 0,
  });
  for (const provider of ["docker", "modal", "vercel"] as const) {
    expect(generationCost(emptyUsage, provider, "unknown-model")).toMatchObject({
      state: "unpriced",
    });
  }
  expect(
    generationCost(emptyUsage, "vercel", "gpt-5.6-sol", {
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
      "gpt-5.6-sol",
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
  expect(generationCost(settled, "e2b", "gpt-5.6-sol", [heartbeat, nextStage])).toEqual({
    state: "estimated",
    usd: 0.1,
    sandboxUsd: 0.05,
    modelUsd: 0.05,
    sandboxSeconds: 12,
    updatedAt: nextStage.updatedAt,
  });
});

test("metering emits live provider-aware costs and records final usage on completion", async () => {
  const output = `${JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      usage: { input: 1_000, output: 500, cacheRead: 100, cacheWrite: 50 },
    },
  })}\n`;
  const inner: SandboxExecutor = {
    run: async (_request, options?: SandboxRunOptions) => {
      options?.onOutput?.("stdout", new TextEncoder().encode(output));
      return { sandboxId: "sandbox", exitCode: 0, stdout: output, stderr: "", outputs: {} };
    },
    close: () => {},
  };
  const snapshots: SandboxCostSnapshot[] = [];
  const recorded: StageUsage[] = [];
  const executor = meteredSandboxExecutor(inner, {
    managedModel: false,
    managedSandbox: false,
    model: "gpt-5.6-sol",
    sandboxProvider: "e2b",
    provider: "openrouter",
  });

  await withUsageLedger(
    async (usage) => {
      recorded.push(usage);
    },
    () =>
      executor.run(
        {
          runId: "run-cost",
          stage: "author-candidate-r1",
          command: ["pi"],
          timeoutMs: 1_000,
          cpu: 4,
          memoryMiB: 8192,
        },
        { onCost: (cost) => snapshots.push(cost) },
      ),
  );

  expect(snapshots.length).toBeGreaterThanOrEqual(3);
  expect(snapshots.at(-1)).toMatchObject({
    stage: "author-candidate-r1",
    state: "estimated",
    sandboxSeconds: 1,
  });
  expect(snapshots.at(-1)?.sandboxUsd).toBeGreaterThan(0);
  expect(snapshots.at(-1)?.modelUsd).toBeGreaterThan(0);
  expect(recorded).toEqual([
    expect.objectContaining({
      stage: "author-candidate-r1",
      provider: "openrouter",
      sandboxSeconds: 1,
      sandboxCostUsd: expect.any(Number),
      modelCostUsd: expect.any(Number),
      tokens: { input: 1_000, output: 500, cacheRead: 100, cacheWrite: 50 },
    }),
  ]);
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

test("non-E2B providers report their sandbox component as unpriced", async () => {
  const snapshots: Array<{ state: string; sandboxUsd?: number }> = [];
  const executor = meteredSandboxExecutor(
    {
      run: async () => ({ sandboxId: "sandbox", exitCode: 0, stdout: "", stderr: "", outputs: {} }),
      close: () => {},
    },
    {
      managedModel: false,
      managedSandbox: false,
      model: "unknown-model",
      sandboxProvider: "modal",
    },
  );
  await executor.run(
    { runId: "run-unpriced", stage: "author-one-r1", command: ["pi"], timeoutMs: 1_000 },
    { onCost: (cost) => snapshots.push(cost) },
  );
  expect(snapshots.at(-1)?.state).toBe("unpriced");
  expect(snapshots.at(-1)?.sandboxUsd).toBeUndefined();
});
