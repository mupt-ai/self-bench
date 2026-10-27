import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "drizzle-orm";
import { gatewayRequests } from "../../src/db/schema.js";
import { createVault } from "../../src/db/vault.js";
import {
  gatewayModelId,
  gatewayTrial,
  pinnedThinking,
} from "../../src/evaluation/gateway-trial.js";
import type { EvaluationInput, Harness } from "../../src/evaluation/types.js";
import { type GatewayConnection, gatewayConnection } from "../../src/gateway/connection.js";
import { gatewayModelPrice, listedModelConfig } from "../../src/gateway/models.js";
import { gatewayRoute } from "../../src/gateway/mount.js";
import { readTrialKey } from "../../src/gateway/trial-key.js";
import { createGatewayUsageStore } from "../../src/gateway/usage-store.js";
import { startUpstream, type UpstreamCall, VAULT_SECRETS } from "../support/gateway-upstream.js";
import { type TestDatabase, testDatabase } from "../support/test-database.js";

// A real trial's path, with no SelfBench code stubbed: gatewayTrial builds the trial's environment,
// the gateway route is mounted in a node:http server as the API mounts it, its usage lands in
// gateway_requests on PGlite, and an HTTP client sends each harness's request shape. The provider is
// the stand-in in support/gateway-upstream.ts; only its address differs from production, since a
// credential's endpoint must be HTTPS on an operator-approved host.

const ORG = 1;
const SECRET = "s".repeat(40);
const VAULT_KEY = "a".repeat(64);
/** Real catalog models, so the gateway's own configs and prices apply. */
const MODELS = {
  openai: "openai/gpt-6-luna",
  anthropic: "anthropic/claude-sonnet-5-5",
  openrouter: "openrouter/openai/gpt-4o-mini",
} as const;

/** The stand-in provider, started at load and stopped after the suite. */
const upstream = startUpstream();

describe("a real trial's path through the gateway", () => {
  let database: TestDatabase;
  let api: Server;
  let apiUrl: string;
  let credentialIds: Record<keyof typeof MODELS, string>;
  let store: ReturnType<typeof createGatewayUsageStore>;
  const failures: unknown[] = [];

  beforeAll(async () => {
    database = await testDatabase();
    store = createGatewayUsageStore(database.db);
    const vault = createVault(database.db, VAULT_KEY).credentials;
    credentialIds = {} as Record<keyof typeof MODELS, string>;
    for (const kind of ["openai", "anthropic", "openrouter"] as const) {
      const saved = await vault.create(
        ORG,
        { name: kind, kind, auth: "api-key", value: VAULT_SECRETS[kind] },
        {},
      );
      credentialIds[kind] = saved.id;
    }
    const route = gatewayRoute({
      secret: SECRET,
      // Stored credentials, with the stand-in's address as their endpoint (see the header).
      credentials: {
        find: async (orgId, id) => {
          const info = await vault.find(orgId, id);
          const kind = info?.kind as keyof typeof MODELS | undefined;
          return info && kind ? { ...info, endpoint: upstream.base[kind] } : undefined;
        },
        secret: (orgId, id) => vault.secret(orgId, id),
      },
      endpoint: (endpoint) => endpoint,
      modelConfig: listedModelConfig,
      modelPrice: gatewayModelPrice,
      recordUsage: (entry) => {
        store.record(entry).catch((error) => failures.push(error));
      },
      captureError: (error) => failures.push(error),
    });
    // As the API mounts it (server.ts): the gateway route ahead of the rest of the API.
    api = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://api.test");
      if (!(await route(request, url, response))) response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => api.close(resolve));
    await database.close();
    await upstream.stop();
  });

  function trialFor(harness: Harness, provider: keyof typeof MODELS, trial: string) {
    const modelName = MODELS[provider];
    const input = {
      modelName,
      credentials: { provider, auth: "api-key", modelCredentialId: credentialIds[provider] },
    } as EvaluationInput;
    const tags = { run: "run-e2e", trial, harness };
    const thinking = pinnedThinking(harness, input.thinking);
    const connection: GatewayConnection = gatewayConnection({
      apiUrl,
      secret: SECRET,
      orgId: ORG,
      credentialId: credentialIds[provider],
      model: gatewayModelId(input),
      ...(thinking ? { thinking } : {}),
      tags,
    });
    // The worker's host environment holds every raw provider key; none may reach the trial.
    const hostEnv = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "raw-openai",
      ANTHROPIC_API_KEY: "raw-anthropic",
      OPENROUTER_API_KEY: "raw-openrouter",
      AI_GATEWAY_API_KEY: "raw-vercel",
      META_API_KEY: "raw-meta",
    };
    const trialEnv = gatewayTrial(input, harness, modelName, hostEnv, connection);
    return { trial: trialEnv, connection, tags, trialKey: connection.key, hostEnv };
  }

  /** The trial's usage rows, once `calls` of them have landed (recordUsage runs after the reply). */
  async function usageRows(trialTag: string, calls: number) {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const rows = await database.db
        .select()
        .from(gatewayRequests)
        .where(sql`${gatewayRequests.tags}->>'trial' = ${trialTag}`);
      if (rows.length >= calls) return rows;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`usage rows for ${trialTag} never landed`);
  }

  /** The request shape each harness sends, to the URL its environment names. */
  const CASES = [
    {
      harness: "codex" as const,
      provider: "openai" as const,
      name: "Codex (OpenAI Responses)",
      send: (env: NodeJS.ProcessEnv, model: string) =>
        fetch(`${env.OPENAI_BASE_URL}/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${env.OPENAI_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            stream: true,
            input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
          }),
        }),
      // Codex's adapter sends the gateway's request id without the `openai/` harbor prefix.
      requestModel: (trial: { model: string }) => trial.model.replace(/^openai\//, ""),
      upstreamPath: "/v1/responses",
      upstreamKey: (call: UpstreamCall) => call.authorization,
      // gpt-6-luna's list price: $0.10 in and $0.50 out per million tokens.
      expectedCost: 8 * 0.1e-6 + 3 * 0.5e-6,
    },
    {
      harness: "claude-code" as const,
      provider: "anthropic" as const,
      name: "Claude Code (Anthropic Messages)",
      send: (env: NodeJS.ProcessEnv, model: string) =>
        fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: "POST",
          headers: {
            "x-api-key": env.ANTHROPIC_API_KEY ?? "",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 64,
            stream: true,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
      requestModel: (trial: { model: string }) => trial.model,
      upstreamPath: "/v1/messages",
      upstreamKey: (call: UpstreamCall) => call.xApiKey,
      // claude-sonnet-5-5's list price: $2 in and $10 out per million tokens.
      expectedCost: 8 * 2e-6 + 3 * 10e-6,
    },
    {
      harness: "pi" as const,
      provider: "openrouter" as const,
      name: "Pi (models.json, Chat Completions)",
      send: (_env: NodeJS.ProcessEnv, model: string, baseUrl: string, key: string) =>
        fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({
            model,
            stream: true,
            messages: [{ role: "user", content: "hello" }],
          }),
        }),
      requestModel: (trial: { model: string }) => trial.model.replace(/^selfbench\//, ""),
      upstreamPath: "/api/v1/chat/completions",
      upstreamKey: (call: UpstreamCall) => call.authorization,
      expectedCost: 0.0123,
    },
  ];

  for (const testCase of CASES) {
    test(`${testCase.name}: served by the pinned model, with the vault's key upstream and a usage row`, async () => {
      const tag = `trial-${testCase.harness}`;
      const { trial, connection, hostEnv, trialKey } = trialFor(
        testCase.harness,
        testCase.provider,
        tag,
      );
      const env = trial.child;
      upstream.calls.length = 0;

      // The environment: the gateway's address and the trial key, no raw provider key anywhere.
      const everything = JSON.stringify({ child: env, args: trial.agentArguments });
      for (const raw of Object.values(hostEnv))
        if (raw.startsWith("raw-")) expect(everything).not.toContain(raw);
      for (const secret of Object.values(VAULT_SECRETS)) expect(everything).not.toContain(secret);
      expect(readTrialKey(trialKey, SECRET)).toMatchObject({
        model: MODELS[testCase.provider],
        tags: { trial: tag },
      });

      // Pi reads its endpoint and model from the models.json the trial writes for it.
      let baseUrl = env.OPENAI_BASE_URL ?? connection.openAiBase;
      let key = env.OPENAI_API_KEY ?? "";
      const requestModel = testCase.requestModel(trial);
      if (testCase.harness === "pi") {
        const argument = trial.agentArguments.find((arg) => arg.startsWith("models_json="));
        const models = JSON.parse((argument ?? "").slice("models_json=".length));
        baseUrl = models.providers.selfbench.baseUrl;
        key = env.OPENAI_API_KEY ?? "";
        expect(models.providers.selfbench.apiKey).toBe("$OPENAI_API_KEY");
      }
      expect(connection.requestModel).toBe(`dari/model/${MODELS[testCase.provider]}`);

      // The harness's request, to the gateway the environment points at.
      const response = await testCase.send(env, requestModel, baseUrl, key);
      expect(response.status).toBe(200);
      const text = await response.text();
      // The pinned model answered: the stand-in echoes the model it was asked for.
      expect(text).toContain(
        `served by ${MODELS[testCase.provider].split("/").slice(1).join("/")}`,
      );
      const native = MODELS[testCase.provider].split("/").slice(1).join("/");
      expect(upstream.calls).toEqual([
        expect.objectContaining({ path: testCase.upstreamPath, model: native }),
      ]);
      // The provider saw the vault's key, never the trial key.
      expect(testCase.upstreamKey(upstream.calls[0] as UpstreamCall)).toContain(
        VAULT_SECRETS[testCase.provider],
      );
      expect(JSON.stringify(upstream.calls)).not.toContain(trialKey);

      // The usage row carries the trial's tags, tokens and cost.
      const [row] = await usageRows(tag, 1);
      expect(failures).toEqual([]);
      expect(row).toMatchObject({
        orgId: ORG,
        credentialId: credentialIds[testCase.provider],
        model: MODELS[testCase.provider],
        status: "completed",
        tags: { run: "run-e2e", trial: tag, harness: testCase.harness },
        inputTokens: 8,
        outputTokens: 3,
      });
      expect(row?.costUsd).toBeCloseTo(testCase.expectedCost, 9);
    });
  }

  test("a request for any model but the pinned one is refused before the provider is called", async () => {
    const { trial } = trialFor("codex", "openai", "trial-refusal");
    upstream.calls.length = 0;
    const other = await fetch(`${trial.child.OPENAI_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${trial.child.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: `dari/model/${MODELS.anthropic}`,
        stream: true,
        input: "hello",
      }),
    });
    expect(other.status).toBe(400);
    await other.text();
    expect(upstream.calls).toEqual([]);
    // The refused call is still recorded against the trial, with no tokens or cost.
    const [refused] = await usageRows("trial-refusal", 1);
    expect(refused).toMatchObject({ status: "selector_error", inputTokens: null, costUsd: null });
  });
});
