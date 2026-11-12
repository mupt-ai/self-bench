import { expect, test } from "bun:test";
import { findModel } from "../src/contracts/models.js";
import { harnessIds } from "../src/evaluation/models.js";
import { subagentRefusal, subagentSupport } from "../src/evaluation/subagents.js";
import { type GatewayUsage, selfBenchPlatform } from "../src/gateway/platform.js";
import { readTrialKey, signTrialKey } from "../src/gateway/trial-key.js";
import { evaluationServer } from "./support/evaluation-fixture.js";

const secret = "s".repeat(40);
const parent = "8d6b2c4e-1f3a-4b5c-9d7e-0a1b2c3d4e5f";
const child = "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9";
const model = "openrouter/deepseek/flash-1017";
const base = {
  orgId: 7,
  model: "anthropic/claude-x",
  credentialId: parent,
  tags: { trial: "r/0" },
  expiresAt: Date.now() + 60_000,
};

test("subagent authorization is exact, uses its own credential, and stays solver spend", async () => {
  const usage: GatewayUsage[] = [];
  const apiKey = signTrialKey({ ...base, subagent: { model, credentialId: child } }, secret);
  const platform = selfBenchPlatform({
    secret,
    credentials: {
      find: async (_org, id) => ({
        id,
        kind: id === child ? "openrouter" : "anthropic",
        auth: "api-key",
      }),
      secret: async (_org, id) => ({ value: `${id}-secret` }),
      renew: async () => {},
    },
    endpoint: (value) => value,
    modelPrice: () => ({ input: 1, output: 2 }),
    recordUsage: (value) => usage.push(value),
    captureError: () => {},
  });
  const router = await platform.resolveRouter({ apiKey });
  expect(router.enabled_models).toEqual([base.model, model]);
  expect(router.strict).toBe(true);
  expect(router.strict_providers).toBeUndefined();
  expect(router.model_prices?.[model]).toEqual({ input: 1, output: 2 });
  expect(await platform.resolveProviderCredential({ apiKey, model })).toEqual({
    apiKey: `${child}-secret`,
  });
  await expect(
    platform.resolveProviderCredential({ apiKey, model: "openrouter/other" }),
  ).rejects.toMatchObject({ status: 401 });
  platform.recordRequest?.({
    summary: {
      request_id: "child-call",
      api_key_id: router.api_key_id,
      selected_model: model,
      status: "completed",
      input_tokens: 5,
      output_tokens: 2,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      total_cost_usd: 0.1,
      cost_source: "pricing",
    } as never,
    tags: { judge: "true", subagent: "false" },
  } as never);
  expect(usage[0]).toMatchObject({
    model,
    credentialId: child,
    tags: { trial: "r/0", subagent: "true" },
    costUsd: 0.1,
  });
  expect(usage[0]?.tags.judge).toBeUndefined();
});

test("keys reject a secondary model on judge keys and repeated or malformed models", () => {
  expect(
    readTrialKey(
      signTrialKey({ ...base, subagent: { model, credentialId: child } }, secret),
      secret,
    )?.subagent?.model,
  ).toBe(model);
  expect(
    readTrialKey(
      signTrialKey({ ...base, subagent: { model: base.model, credentialId: child } }, secret),
      secret,
    ),
  ).toBeUndefined();
  expect(
    readTrialKey(
      signTrialKey({ ...base, subagent: { model: "invalid", credentialId: child } }, secret),
      secret,
    ),
  ).toBeUndefined();
  expect(
    readTrialKey(
      signTrialKey(
        {
          orgId: 7,
          tags: {},
          expiresAt: base.expiresAt,
          judge: { credentialId: parent, provider: "anthropic" },
          subagent: { model, credentialId: child },
        },
        secret,
      ),
      secret,
    ),
  ).toBeUndefined();
});

test("comparisons freeze a subagent model, and refuse one the gateway cannot serve and price", async () => {
  const fixture = await evaluationServer();
  const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
  try {
    const credential = async (kind: string) => {
      const response = await fixture.request(
        "/api/orgs/avyay/credentials",
        post({ kind, name: kind, value: `fake-${kind}` }),
      );
      expect(response.status).toBe(201);
      return (await response.json()).id as string;
    };
    const router = await credential("openrouter");
    const sandbox = await credential("e2b");
    const subagent = { catalogId: "deepseek-v4-pro-0813", credentialId: router };
    const row = {
      catalogId: "gpt-6-sol",
      credentialId: router,
      harnesses: ["claude-code"],
      thinking: "high",
      subagent,
    };
    const compare = async (change: object = {}) => {
      const body = {
        id: crypto.randomUUID(),
        tasks: [{ runId: "run-one", taskId: "task-one" }],
        models: [{ ...row, ...change }],
        sandbox: "e2b",
        sandboxCredentialId: sandbox,
      };
      const response = await fixture.request(`${fixture.base}/comparisons`, post(body));
      return { status: response.status, text: await response.text() };
    };
    expect((await compare()).status).toBe(202);
    // Frozen with the gateway's id for it, and the level its calls are pinned to.
    expect(fixture.starts[0]?.subagent).toEqual({
      catalogId: "deepseek-v4-pro-0813",
      model: "openrouter/deepseek/deepseek-v4-pro-0813",
      label: findModel("deepseek-v4-pro-0813")?.label ?? "",
      credentialId: router,
      thinking: "high",
    });
    // A credential the workspace does not have, the run's own model, and an unknown model.
    expect(
      await compare({ subagent: { ...subagent, credentialId: crypto.randomUUID() } }),
    ).toMatchObject({ status: 400, text: expect.stringContaining("matching provider credential") });
    expect(await compare({ subagent: { ...subagent, catalogId: "gpt-6-sol" } })).toMatchObject({
      status: 400,
      text: expect.stringContaining("the run's own model"),
    });
    expect((await compare({ subagent: { ...subagent, catalogId: "no-such-model" } })).status).toBe(
      400,
    );
    // Only Claude Code and Codex take a subagent model.
    for (const harness of harnessIds) {
      const reply = await compare({ harnesses: [harness] });
      expect(reply.status).toBe(subagentSupport[harness].configurable ? 202 : 400);
      if (!subagentSupport[harness].configurable && reply.text.includes("subagent"))
        expect(reply.text).toContain("only Claude Code and Codex do");
    }
    // Dari's router picks its own model for each call, so it is no model to pin subagents to.
    const dari = await credential("dari");
    expect(
      await compare({ subagent: { catalogId: "dari/routing", credentialId: dari } }),
    ).toMatchObject({ status: 400, text: expect.stringContaining("Dari's router") });
  } finally {
    await fixture.close();
  }
});

test("a subagent model is refused wherever it cannot be served by name", () => {
  const both = ["claude-code", "codex"] as const;
  expect(subagentRefusal(both, "anthropic", "openrouter")).toBeUndefined();
  expect(subagentRefusal(both, "openrouter", "openrouter")).toBeUndefined();
  expect(subagentRefusal(both, "dari", "vercel-ai-gateway")).toBeUndefined();
  expect(subagentRefusal(["pi"], "openrouter", "openrouter")).toContain("Pi takes no subagent");
  expect(subagentRefusal(both, "custom", "openrouter")).toContain("custom endpoint");
  expect(subagentRefusal(both, "openrouter", "dari")).toContain("Dari's router");
  expect(subagentRefusal(both, "openrouter", "custom")).toContain("custom endpoint");
});
