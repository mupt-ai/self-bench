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

  test("a call with no list price is recorded unpriced, not as a free call", async () => {
    const recorded: { costUsd: number | null; costSource: string | null }[] = [];
    const record = (
      modelPrice?: (model: string) => undefined | { input: number; output: number },
    ) => {
      const gateway = platform(credential("custom", "https://approved.example/v1"), {
        recordUsage: (usage) => recorded.push(usage),
        ...(modelPrice ? { modelPrice } : {}),
      });
      return gateway;
    };
    const summarise = (gateway: ReturnType<typeof record>, model: string) =>
      gateway.resolveRouter({ apiKey: trialKey({ model }) }).then((router) =>
        gateway.recordRequest?.({
          summary: {
            request_id: `r-${model}`,
            status: "completed",
            api_key_id: router.api_key_id,
            input_tokens: 8,
            output_tokens: 3,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            total_cost_usd: 0,
            cost_source: "pricing",
          } as never,
          tags: {},
        } as never),
      );
    // No list price for the model: the gateway's zero placeholder is not a cost.
    await summarise(record(), "custom/acme-coder");
    // With a list price, the same call is priced.
    await summarise(
      record(() => ({ input: 2, output: 8 })),
      "custom/acme-coder",
    );
    expect(recorded).toEqual([
      expect.objectContaining({ costUsd: null, costSource: null }),
      expect.objectContaining({ costUsd: 0, costSource: "pricing" }),
    ]);
  });

  test("the managed model credential is SelfBench's own OpenRouter key, when it is set", async () => {
    const vault = {
      find: async () => undefined,
      secret: async () => undefined,
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
