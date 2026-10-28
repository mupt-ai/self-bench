import { describe, expect, test } from "bun:test";
import type { CredentialInfo } from "../../src/db/credentials.js";
import {
  type SelfBenchGatewayDeps,
  selfBenchPlatform,
  withManagedModel,
} from "../../src/gateway/platform.js";
import {
  MANAGED_MODEL_CREDENTIAL,
  readTrialKey,
  signTrialKey,
} from "../../src/gateway/trial-key.js";

// The platform a trial key resolves to: which model and credential it pins, how it is priced,
// and what it refuses. The route and its wire behaviour are covered in gateway.test.ts.

const SECRET = "s".repeat(40);
const CREDENTIAL = "8d6b2c4e-1f3a-4b5c-9d7e-0a1b2c3d4e5f";
const MODEL = "openrouter/acme/model-a";
const JUDGE = "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9";

/** A key only a task's judge calls with, for its Anthropic credential. */
function judgeKey(): string {
  return signTrialKey(
    {
      orgId: 7,
      judge: { credentialId: JUDGE, provider: "anthropic" },
      tags: { run: "r1", trial: "t1" },
      expiresAt: Date.now() + 60_000,
    },
    SECRET,
  );
}

function trialKey(overrides: Partial<Parameters<typeof signTrialKey>[0]> = {}): string {
  return signTrialKey(
    {
      orgId: 7,
      credentialId: CREDENTIAL,
      model: MODEL,
      tags: { run: "r1", trial: "t1" },
      expiresAt: Date.now() + 60_000,
      ...overrides,
    },
    SECRET,
  );
}

describe("the platform a trial key resolves to", () => {
  const credential = (kind: string, endpoint?: string) =>
    ({
      id: CREDENTIAL,
      kind,
      auth: "api-key",
      ...(endpoint ? { endpoint } : {}),
    }) as CredentialInfo;
  const platform = (
    found: Awaited<ReturnType<SelfBenchGatewayDeps["credentials"]["find"]>>,
    deps: Partial<SelfBenchGatewayDeps> = {},
  ) =>
    selfBenchPlatform({
      secret: SECRET,
      endpoint: (endpoint) => {
        if (!endpoint.startsWith("https://approved.example/")) throw new Error("not allowed");
        return endpoint;
      },
      credentials: {
        find: async () => found,
        secret: async () => ({ value: "byok-secret" }),
        renew: async () => {},
      },
      recordUsage: () => {},
      captureError: () => {},
      ...deps,
    });

  test("pins the key's thinking level and prices the model at its list price", async () => {
    const router = await platform(credential("openai"), {
      modelPrice: (model) => (model === "openai/gpt-x" ? { input: 2, output: 8 } : undefined),
    }).resolveRouter({ apiKey: trialKey({ model: "openai/gpt-x", thinking: "high" }) });
    expect(router).toMatchObject({
      enabled_models: ["openai/gpt-x"],
      model_prices: { "openai/gpt-x": { input: 2, output: 8 } },
      model_thinking_levels: { "openai/gpt-x": ["high"] },
      strict: true,
      zdr: false,
    });
    expect(router.model_configs).toBeUndefined();
    // Without a pinned level, each call's own level is served.
    const free = await platform(credential("openai")).resolveRouter({
      apiKey: trialKey({ model: "openai/gpt-x" }),
    });
    expect(free.model_thinking_levels).toBeUndefined();
    expect(free.model_prices).toBeUndefined();
  });

  test("a listed model's config takes the pinned level as its default", async () => {
    const router = await platform(credential("openrouter"), {
      modelConfig: () => ({
        provider: "openrouter",
        native_model_id: "acme/model-a",
        api: "openai-completions",
        default_thinking_level: "low",
        cost: { input: 1, output: 1 },
      }),
    }).resolveRouter({ apiKey: trialKey({ thinking: "max" }) });
    expect(router.model_configs?.[MODEL]?.default_thinking_level).toBe("max");
  });

  test("serves a custom endpoint's model only on an endpoint the operator allows", async () => {
    const allowed = platform(credential("custom", "https://approved.example/v1"));
    const apiKey = trialKey({ model: "custom/acme-coder" });
    expect((await allowed.resolveRouter({ apiKey })).model_configs).toEqual({
      "custom/acme-coder": {
        provider: "custom",
        native_model_id: "acme-coder",
        api: "openai-completions",
        base_url: "https://approved.example/v1",
        cost: { input: 0, output: 0 },
      },
    });
    expect(await allowed.resolveProviderCredential({ apiKey, model: "custom/acme-coder" })).toEqual(
      {
        apiKey: "byok-secret",
        baseUrl: "https://approved.example/v1",
      },
    );
    const refused = platform(credential("custom", "https://internal.example/v1"));
    await expect(refused.resolveRouter({ apiKey })).rejects.toMatchObject({ status: 403 });
  });

  test("records each call as the gateway priced it, a judge's under its own key", async () => {
    const recorded: { credentialId: string; model: string; tags: object; costUsd: unknown }[] = [];
    const gateway = platform(credential("openai"), {
      recordUsage: (usage) => recorded.push(usage),
    });
    const record = async (apiKey: string, model: string, cost: number | null) => {
      const router = await gateway.resolveRouter({ apiKey });
      gateway.recordRequest?.({
        summary: {
          request_id: `r-${model}`,
          status: "completed",
          api_key_id: router.api_key_id,
          selected_model: model,
          total_cost_usd: cost,
          cost_source: cost === null ? null : "pricing",
        } as never,
        tags: {},
      } as never);
    };
    await record(trialKey({ model: "openai/gpt-x" }), "openai/gpt-x", 0.5);
    // Neither the provider nor a list price priced it: unpriced, not free.
    await record(judgeKey(), "anthropic/claude-x", null);
    expect(recorded).toEqual([
      expect.objectContaining({ credentialId: CREDENTIAL, model: "openai/gpt-x", costUsd: 0.5 }),
      expect.objectContaining({
        credentialId: JUDGE,
        model: "anthropic/claude-x",
        tags: { run: "r1", trial: "t1", judge: "true" },
        costUsd: null,
      }),
    ]);
  });

  test("a judge's key calls any model of its provider on the judge's credential, and only that", async () => {
    const keys: Record<string, string> = { [CREDENTIAL]: "solver-key", [JUDGE]: "judge-key" };
    const gateway = platform(credential("openai"), {
      credentials: {
        find: async (_orgId, id) => ({ ...credential("openai"), id }),
        secret: async (_orgId, id) => ({ value: keys[id] ?? "" }),
        renew: async () => {},
      },
    });
    const apiKey = judgeKey();
    expect(await gateway.resolveRouter({ apiKey })).toMatchObject({
      enabled_models: [],
      strict: true,
      strict_providers: ["anthropic"],
      model_fallback_enabled: false,
    });
    expect(
      await gateway.resolveProviderCredential({ apiKey, model: "anthropic/claude-x" }),
    ).toEqual({ apiKey: "judge-key" });
    // Not another provider's models, and not the model under test: that is the solver key's alone.
    for (const model of ["openai/gpt-x", "openai/gpt-y"])
      await expect(gateway.resolveProviderCredential({ apiKey, model })).rejects.toMatchObject({
        status: 401,
      });
    // A key serves the model under test or a judge, never both, and a solver names both parts.
    const judge = { credentialId: JUDGE, provider: "anthropic" };
    for (const key of [
      {},
      { model: "openai/gpt-x" },
      { credentialId: CREDENTIAL },
      { credentialId: CREDENTIAL, model: "openai/gpt-x", judge },
      { model: "openai/gpt-x", judge },
    ])
      expect(
        readTrialKey(
          signTrialKey({ orgId: 7, tags: {}, expiresAt: Date.now() + 60_000, ...key }, SECRET),
          SECRET,
        ),
      ).toBeUndefined();
  });

  test("a sign-in is served on the plan the platform supplies, never as an API key", async () => {
    const claude = platform({ ...credential("anthropic"), auth: "claude-login" } as never);
    const apiKey = trialKey({ model: "anthropic/claude-x" });
    expect(await claude.resolveProviderCredential({ apiKey, model: "anthropic/claude-x" })).toEqual(
      { apiKey: "byok-secret", subscription: "anthropic_claude_code" },
    );
  });

  test("the managed model credential is SelfBench's own OpenRouter key, when it is set", async () => {
    const vault = {
      find: async () => undefined,
      secret: async () => undefined,
      renew: async () => {},
    };
    const managed = withManagedModel(vault, "platform-key");
    expect(await managed.find(7, MANAGED_MODEL_CREDENTIAL)).toMatchObject({ kind: "openrouter" });
    expect(await managed.secret(7, MANAGED_MODEL_CREDENTIAL)).toEqual({ value: "platform-key" });
    expect(await managed.find(7, CREDENTIAL)).toBeUndefined();
    const off = withManagedModel(vault, undefined);
    expect(await off.find(7, MANAGED_MODEL_CREDENTIAL)).toBeUndefined();
    // Its trial keys carry the managed id in place of a credential's UUID.
    const key = trialKey({ credentialId: MANAGED_MODEL_CREDENTIAL });
    expect(readTrialKey(key, SECRET)?.credentialId).toBe(MANAGED_MODEL_CREDENTIAL);
  });
});

describe("a custom endpoint's protocol", () => {
  test("Codex's trial calls the custom endpoint with Responses; other harnesses with Chat Completions", async () => {
    const custom = () =>
      selfBenchPlatform({
        secret: SECRET,
        endpoint: (endpoint) => endpoint,
        credentials: {
          find: async () =>
            ({
              id: CREDENTIAL,
              kind: "custom",
              auth: "api-key",
              endpoint: "https://approved.example/v1",
            }) as CredentialInfo,
          secret: async () => ({ value: "byok-secret" }),
          renew: async () => {},
        },
        recordUsage: () => {},
        captureError: () => {},
      });
    const model = "custom/acme-coder";
    const responses = await custom().resolveRouter({
      apiKey: trialKey({ model, api: "openai-responses" }),
    });
    expect(responses.model_configs?.[model]).toMatchObject({ api: "openai-responses" });
    const completions = await custom().resolveRouter({ apiKey: trialKey({ model }) });
    expect(completions.model_configs?.[model]).toMatchObject({ api: "openai-completions" });
  });
});
