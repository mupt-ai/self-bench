import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gatewayRequestModel } from "../../src/evaluation/gateway-trial.js";
import type { Harness } from "../../src/evaluation/types.js";
import { readTrialKey } from "../../src/gateway/trial-key.js";
import { gatewayModelPrice } from "../../src/gateways/catalog.js";
import {
  CREDENTIALS,
  type Credential,
  messages,
  ORG,
  responses,
  SECRET,
  startTrialApi,
} from "../support/gateway-trial-api.js";
import { UPSTREAM_KEYS, type UpstreamCall, VAULT_SECRETS } from "../support/gateway-upstream.js";

// Each harness's request on each kind of credential, from the trial's environment through the
// gateway to the provider's stand-in and the usage row (support/gateway-trial-api.ts).

const native = (model: string) => model.split("/").slice(1).join("/");

describe("a real trial's path through the gateway", () => {
  let api: Awaited<ReturnType<typeof startTrialApi>>;
  beforeAll(async () => {
    api = await startTrialApi();
  });
  afterAll(() => api.close());

  /** The request each harness sends, to the gateway its environment points at. */
  const CASES: {
    name: string;
    harness: Harness;
    credential: Credential;
    send: (
      env: NodeJS.ProcessEnv,
      trial: { model: string; agentArguments: string[] },
    ) => Promise<Response>;
    upstreamPath: string;
    upstreamKey: (call: UpstreamCall) => string | null;
    expectedCost: number;
  }[] = [
    {
      name: "Codex on an OpenAI key (Responses)",
      harness: "codex",
      credential: "openai",
      // Codex's adapter sends the gateway's model id without the `openai/` Harbor prefix.
      send: (env, trial) => responses(env, trial.model.replace(/^openai\//, "")),
      upstreamPath: "/v1/responses",
      upstreamKey: (call) => call.authorization,
      // gpt-6-luna's list price: $0.10 in and $0.50 out per million tokens.
      expectedCost: 8 * 0.1e-6 + 3 * 0.5e-6,
    },
    {
      name: "Claude Code on an Anthropic key (Messages)",
      harness: "claude-code",
      credential: "anthropic",
      send: (env, trial) => messages(env, trial.model),
      upstreamPath: "/v1/messages",
      upstreamKey: (call) => call.xApiKey,
      // claude-sonnet-5-5's list price: $2 in and $10 out per million tokens.
      expectedCost: 8 * 2e-6 + 3 * 10e-6,
    },
    {
      name: "Pi on an OpenRouter key (models.json, Chat Completions)",
      harness: "pi",
      credential: "openrouter",
      send: (env, trial) => {
        const argument = trial.agentArguments.find((arg) => arg.startsWith("models_json="));
        const provider = JSON.parse((argument ?? "").slice("models_json=".length)).providers
          .selfbench;
        expect(provider.apiKey).toBe("$OPENAI_API_KEY");
        return fetch(`${provider.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: trial.model.replace(/^selfbench\//, ""),
            stream: true,
            messages: [{ role: "user", content: "hello" }],
          }),
        });
      },
      upstreamPath: "/api/v1/chat/completions",
      upstreamKey: (call) => call.authorization,
      // OpenRouter's own reported charge.
      expectedCost: 0.0123,
    },
    {
      name: "Codex on a Meta key (Meta's Responses API)",
      harness: "codex",
      credential: "meta",
      send: (env, trial) => responses(env, trial.model.replace(/^openai\//, "")),
      upstreamPath: "/v1/responses",
      upstreamKey: (call) => call.authorization,
      expectedCost:
        8 * (gatewayModelPrice("meta/muse-spark-1.3")?.input ?? 0) * 1e-6 +
        3 * (gatewayModelPrice("meta/muse-spark-1.3")?.output ?? 0) * 1e-6,
    },
    {
      name: "Codex on a ChatGPT sign-in (the Codex backend, on the plan)",
      harness: "codex",
      credential: "codex-login",
      send: (env, trial) => responses(env, trial.model.replace(/^openai\//, "")),
      upstreamPath: "/codex/responses",
      upstreamKey: (call) => call.authorization,
      // A plan bills nothing; its calls are priced at the model's list price for comparison.
      expectedCost: 8 * 0.1e-6 + 3 * 0.5e-6,
    },
    {
      name: "Claude Code on a Claude sign-in (Messages, on the plan)",
      harness: "claude-code",
      credential: "claude-login",
      send: (env, trial) => messages(env, trial.model),
      upstreamPath: "/v1/messages",
      upstreamKey: (call) => call.authorization,
      expectedCost: 8 * 2e-6 + 3 * 10e-6,
    },
  ];

  for (const testCase of CASES) {
    test(`${testCase.name}: served by the pinned model, with the vault's secret upstream and a usage row`, async () => {
      const tag = `trial-${testCase.credential}-${testCase.harness}`;
      const { model } = CREDENTIALS[testCase.credential];
      const { trial, connection, hostEnv, input } = api.trialFor(
        testCase.harness,
        testCase.credential,
        tag,
      );
      const env = trial.child;
      api.upstream.calls.length = 0;

      // The environment: the gateway's address and the trial key, no raw provider key or sign-in.
      const everything = JSON.stringify({ child: env, args: trial.agentArguments });
      for (const raw of Object.values(hostEnv))
        if (raw.startsWith("raw-")) expect(everything).not.toContain(raw);
      for (const secret of [...Object.values(VAULT_SECRETS), ...Object.values(UPSTREAM_KEYS)])
        expect(everything).not.toContain(secret);
      expect(readTrialKey(connection.key, SECRET)).toMatchObject({ model, tags: { trial: tag } });
      expect(gatewayRequestModel(input)).toBe(`dari/model/${model}`);

      const response = await testCase.send(env, trial);
      const text = await response.text();
      expect({ status: response.status, text }).toMatchObject({ status: 200 });
      // The pinned model answered: the stand-in echoes the model it was asked for.
      expect(text).toContain(`served by ${native(model)}`);
      expect(api.upstream.calls).toEqual([
        expect.objectContaining({ path: testCase.upstreamPath, model: native(model) }),
      ]);
      // The provider saw the vault's secret (a sign-in's access token), never the trial key.
      expect(testCase.upstreamKey(api.upstream.calls[0] as UpstreamCall)).toContain(
        UPSTREAM_KEYS[testCase.credential],
      );
      expect(JSON.stringify(api.upstream.calls)).not.toContain(connection.key);

      // The usage row carries the trial's tags, tokens and cost.
      const [row] = await api.usageRows(tag, 1);
      expect(api.failures).toEqual([]);
      expect(row).toMatchObject({
        orgId: ORG,
        credentialId: api.ids[testCase.credential],
        model,
        status: "completed",
        tags: { run: "run-e2e", trial: tag, harness: testCase.harness },
        inputTokens: 8,
        outputTokens: 3,
      });
      expect(row?.costUsd).toBeCloseTo(testCase.expectedCost, 9);
    });
  }
});
