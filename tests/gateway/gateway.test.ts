import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialInfo } from "../../src/db/credentials.js";
import { gatewayRoute } from "../../src/gateway/mount.js";
import type { GatewayUsage } from "../../src/gateway/platform.js";
import { readTrialKey, signTrialKey, type TrialKey } from "../../src/gateway/trial-key.js";

// SelfBench's gateway end to end: a trial key pins one model on the org's own credential, the
// real gateway handler serves it through the API's route, and the provider's billed cost lands
// in the usage record. A local stand-in for OpenRouter plays the provider.

const SECRET = "s".repeat(40);
const CREDENTIAL = "8d6b2c4e-1f3a-4b5c-9d7e-0a1b2c3d4e5f";
const MODEL = "openrouter/acme/model-a";

const upstreamCalls: { model: string; authorization: string | null }[] = [];
const usage: GatewayUsage[] = [];
let upstreamStatus = 200;
let upstream: ReturnType<typeof Bun.serve>;
let api: Server;
let apiUrl: string;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string };
      upstreamCalls.push({
        model: body.model,
        authorization: request.headers.get("authorization"),
      });
      if (upstreamStatus !== 200)
        return Response.json(
          { error: { message: "upstream unavailable" } },
          { status: upstreamStatus },
        );
      return completion(body.model);
    },
  });
  const credential: CredentialInfo = {
    id: CREDENTIAL,
    kind: "custom",
    auth: "api-key",
    endpoint: `http://127.0.0.1:${upstream.port}/v1`,
  } as CredentialInfo;
  const route = gatewayRoute({
    secret: SECRET,
    endpoint: (endpoint) => endpoint,
    credentials: {
      find: async (orgId, id) => (orgId === 7 && id === CREDENTIAL ? credential : undefined),
      secret: async (orgId, id) =>
        orgId === 7 && id === CREDENTIAL ? { value: "byok-secret" } : undefined,
      renew: async () => {},
    },
    modelConfig: (model) =>
      model === MODEL
        ? {
            provider: "openrouter",
            native_model_id: "acme/model-a",
            api: "openai-completions",
            supported_thinking_levels: ["off"],
            default_thinking_level: "off",
            cost: { input: 1, output: 1, cached_input: 0.1, cache_write: 1 },
          }
        : undefined,
    recordUsage: (entry) => usage.push(entry),
    captureError: () => {},
  });
  api = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://api.test");
    if (!(await route(request, url, response))) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await upstream.stop(true);
  await new Promise((resolve) => api.close(resolve));
});

beforeEach(() => {
  upstreamCalls.length = 0;
  usage.length = 0;
  upstreamStatus = 200;
});

function trialKey(overrides: Partial<TrialKey> = {}): string {
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

async function chat(
  key: string,
  model = `dari/model/${MODEL}`,
  headers: Record<string, string> = {},
) {
  return await fetch(`${apiUrl}/gateway/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hello" }] }),
  });
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
}

test("serves the pinned model on the org's own key and records its billed cost", async () => {
  const response = await chat(trialKey());
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("served by acme/model-a");
  expect(upstreamCalls).toEqual([{ model: "acme/model-a", authorization: "Bearer byok-secret" }]);
  await waitFor(() => usage.length === 1);
  expect(usage[0]).toMatchObject({
    orgId: 7,
    credentialId: CREDENTIAL,
    model: MODEL,
    tags: { run: "r1", trial: "t1" },
    status: "completed",
    outputTokens: 3,
    costUsd: 0.0123,
    costSource: "provider",
  });
});

test("a tag header can add labels but never reattribute spend", async () => {
  const response = await chat(trialKey(), undefined, { "x-dari-tags": "trial=forged,setting=low" });
  await response.text();
  await waitFor(() => usage.length === 1);
  expect(usage[0]?.tags).toEqual({ run: "r1", trial: "t1", setting: "low" });
});

test("refuses any model but the pinned one", async () => {
  const unpinned = await chat(trialKey(), "dari/routing");
  expect(unpinned.status).toBe(400);
  const other = await chat(trialKey(), "dari/model/openrouter/acme/model-b");
  expect(other.status).toBe(400);
  expect(upstreamCalls).toEqual([]);
});

test("refuses forged, expired, and foreign keys before any provider call", async () => {
  const forged = `${trialKey().slice(0, -4)}AAAA`;
  const expired = trialKey({ expiresAt: Date.now() - 1 });
  const foreign = trialKey({ orgId: 8 });
  for (const key of [forged, expired, foreign, "sk-or-plain-provider-key"])
    expect((await chat(key)).status).toBe(401);
  expect(upstreamCalls).toEqual([]);
});

test("records failed calls too, without retrying another model", async () => {
  upstreamStatus = 500;
  const response = await chat(trialKey());
  expect(response.status).toBeGreaterThanOrEqual(400);
  await response.text();
  await waitFor(() => usage.length === 1);
  expect(usage[0]?.status).toBe("provider_error");
  expect(new Set(upstreamCalls.map((call) => call.model))).toEqual(new Set(["acme/model-a"]));
});

test("trial keys round-trip and reject tampering", () => {
  const key = trialKey();
  expect(readTrialKey(key, SECRET)?.model).toBe(MODEL);
  expect(readTrialKey(key, "x".repeat(40))).toBeUndefined();
  expect(readTrialKey(key.replace("sbk_", ""), SECRET)).toBeUndefined();
});

function completion(model: string): Response {
  const usage = {
    prompt_tokens: 8,
    completion_tokens: 3,
    total_tokens: 11,
    prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
    cost: 0.0123,
  };
  const chunks = [
    {
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: `served by ${model}` },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    { choices: [], usage },
  ].map(
    (chunk) =>
      `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", created: 0, model, ...chunk })}\n\n`,
  );
  return new Response(`${chunks.join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

test("usage rows sum to a trial's cost, flagging unpriced calls", async () => {
  const { testDatabase } = await import("../support/test-database.js");
  const { createGatewayUsageStore } = await import("../../src/gateway/usage-store.js");
  const database = await testDatabase();
  try {
    const store = createGatewayUsageStore(database.db);
    const row = (requestId: string, trial: string, costUsd: number | null): GatewayUsage => ({
      requestId,
      orgId: 7,
      credentialId: CREDENTIAL,
      model: MODEL,
      tags: { run: "r1", trial },
      status: "completed",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd,
      costSource: costUsd === null ? null : "provider",
    });
    await store.record(row("a", "t1", 0.25));
    await store.record(row("a", "t1", 0.25)); // a repeat delivery is ignored
    await store.record(row("b", "t1", 0.5));
    await store.record(row("c", "t2", null));
    // A refused call used no tokens: it costs nothing rather than leaving the total unknown.
    await store.record({ ...row("d", "t1", null), inputTokens: null, outputTokens: null });
    expect(await store.trialCost(7, "t1")).toEqual({ costUsd: 0.75, complete: true });
    expect(await store.trialCost(7, "t2")).toEqual({ costUsd: 0, complete: false });
    expect(await store.trialCost(8, "t1")).toBeUndefined();
  } finally {
    await database.close();
  }
});

test("a connection's key is served by the gateway it points at", async () => {
  const { gatewayConnection } = await import("../../src/gateway/connection.js");
  const connection = gatewayConnection(`${apiUrl}/`, SECRET, {
    orgId: 7,
    credentialId: CREDENTIAL,
    model: MODEL,
    tags: { run: "r2", trial: "t9" },
  });
  expect(connection.openAiBase).toBe(`${apiUrl}/gateway/v1`);
  expect(connection.host).toBe("127.0.0.1");
  const response = await fetch(`${connection.openAiBase}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${connection.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: `dari/model/${MODEL}`,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  expect(response.status).toBe(200);
  await response.text();
  await waitFor(() => usage.length === 1);
  expect(usage[0]?.tags).toEqual({ run: "r2", trial: "t9" });
});
