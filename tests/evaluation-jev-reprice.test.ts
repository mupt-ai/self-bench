import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repriceJevRouter } from "../maintenance/reprice-jev-router.js";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { OPENROUTER_GENERATIONS } from "../src/evaluation/gateway-cost.js";
import { OPENROUTER_BILLING } from "../src/evaluation/jev-cost.js";
import {
  evaluationPrefix,
  getEvaluation,
  initialEvaluation,
  saveEvaluation,
} from "../src/evaluation/store.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

// Provider-free integration: only synthetic accounting; neither dry run nor apply invokes a model.
test("Jev recovery dry run is read-only; apply writes evidence and only complete prices", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-reprice-"));
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  const store = new LocalArtifactStore(root);
  const run = initialEvaluation(
    {
      ...evaluationInput(),
      modelName: "openrouter/typesafe/jev-router",
      credentials: {
        modelCredentialId: "model",
        sandboxCredentialId: "sandbox",
        provider: "openrouter",
      },
    },
    "Jev",
  );
  run.status = "completed";
  const trial = run.trials[0];
  if (!trial) throw new Error("Missing trial");
  Object.assign(trial, {
    status: "completed",
    harness: "pi",
    modelVerified: true,
    apiCostUsd: 0,
    billedCostUsd: 0,
  });
  trial.artifacts = [`0/${OPENROUTER_GENERATIONS}`, "0/agent/pi.txt"];
  const prefix = `${evaluationPrefix(run.repoId, run.id)}artifacts/`;
  await store.put(
    `${prefix}0/${OPENROUTER_GENERATIONS}`,
    Buffer.from(
      JSON.stringify({
        generationIds: ["gen-root"],
        usage: [{ id: "gen-root", prompt: 10, completion: 5 }],
      }),
    ),
    "application/json",
  );
  await store.put(
    `${prefix}0/agent/pi.txt`,
    Buffer.from("[Earlier output truncated]\n"),
    "text/plain",
  );
  await saveEvaluation(store, run);
  const outer = {
    model: "worker-model",
    id: "gen-root",
    request_id: "req-root",
    session_id: "session",
    created_at: "2026-01-01T00:00:00Z",
    router: "typesafe/jev-router",
    total_cost: 0,
    upstream_inference_cost: 0,
    is_byok: false,
    native_tokens_prompt: 0,
    native_tokens_completion: 0,
    upstream_id: null,
    provider_responses: [],
  };
  const child = {
    ...outer,
    id: "gen-child",
    native_tokens_prompt: 10,
    native_tokens_completion: 5,
    router: null,
    is_byok: true,
    upstream_inference_cost: 0.12345678,
    upstream_id: "upstream",
    provider_responses: [{ id: "upstream", status: 200 }],
  };
  let truncated = false;
  globalThis.fetch = (async (url: string) => {
    if (url.endsWith("/analytics/query"))
      return Response.json({
        data: {
          data: [outer, child].map((r) => ({ generation_id: r.id, session_id: r.session_id })),
          metadata: { truncated, row_count: 2 },
        },
      });
    return Response.json({ data: url.endsWith("gen-root") ? outer : child });
  }) as unknown as typeof fetch;
  globalThis.setTimeout = ((callback: () => void) => {
    queueMicrotask(callback);
    return 0;
  }) as unknown as typeof setTimeout;
  try {
    const before = await getEvaluation(store, run.repoId, run.id);
    const dry = await repriceJevRouter(store, run.repoId, run.id, "inference", "billing", false);
    expect(dry.applied).toBe(false);
    expect(dry.trials[0]?.after.apiCostUsd).toBeCloseTo(0.12345678, 10);
    expect(await getEvaluation(store, run.repoId, run.id)).toEqual(before);
    expect(await store.getByKey(`${prefix}0/${OPENROUTER_BILLING}`)).toBeUndefined();
    truncated = true;
    expect(
      (await repriceJevRouter(store, run.repoId, run.id, "inference", "billing", true)).applied,
    ).toBe(false);
    truncated = false;
    expect(
      (await repriceJevRouter(store, run.repoId, run.id, "inference", "billing", true)).applied,
    ).toBe(true);
    expect((await getEvaluation(store, run.repoId, run.id))?.trials[0]?.apiCostUsd).toBeCloseTo(
      0.12345678,
      10,
    );
    expect(await store.getByKey(`${prefix}0/${OPENROUTER_BILLING}`)).toBeDefined();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimeout;
    await rm(root, { recursive: true, force: true });
  }
});
