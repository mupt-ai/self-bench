import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialInfo } from "../../src/db/credentials.js";
import { gatewayRoute } from "../../src/gateway/mount.js";
import type { GatewayUsage } from "../../src/gateway/platform.js";
import { type CustomEndpointApi, signTrialKey } from "../../src/gateway/trial-key.js";

// Fireworks' Fire Pass behind a Custom Endpoint: a key (`fpk_…`) that reaches only Fireworks'
// routers, such as Kimi Fast, over Chat Completions and Messages but never Responses. SelfBench's
// real gateway handler serves the router as Pi's registry does, over Fireworks' Messages API,
// whichever harness calls it, and prices each call at the router's list rates. The upstream is a
// local stand-in that answers as Fireworks' Messages API does.

const SECRET = "s".repeat(40);
const CREDENTIAL = "5b0e7c1a-2d3f-4e5a-8b6c-7d8e9f0a1b2c";
const ROUTER = "accounts/fireworks/routers/kimi-fast-latest";
const MODEL = `custom/${ROUTER}`;

interface Call {
  path: string;
  authorization: string | null;
  body: Record<string, unknown>;
}
const calls: Call[] = [];
const usage: GatewayUsage[] = [];
const servedPriced: string[] = [];
let upstream: ReturnType<typeof Bun.serve>;
let api: Server;
let apiUrl: string;

const sse = (events: object[]) =>
  new Response(
    events
      .map(
        (event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ path, authorization: request.headers.get("authorization"), body });
      if (path !== "/inference/v1/messages")
        return new Response("Responses API is not supported with Fire Pass keys", { status: 404 });
      return sse([
        {
          type: "message_start",
          message: {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: ROUTER,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1_000_000, output_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1_000_000 },
        },
        { type: "message_stop" },
      ]);
    },
  });
  // Saved as the docs give it: Fireworks' OpenAI base URL.
  const credential = {
    id: CREDENTIAL,
    kind: "custom",
    auth: "api-key",
    endpoint: `http://127.0.0.1:${upstream.port}/inference/v1`,
  } as CredentialInfo;
  const route = gatewayRoute({
    secret: SECRET,
    endpoint: (endpoint) => endpoint,
    credentials: {
      find: async (orgId, id) => (orgId === 7 && id === CREDENTIAL ? credential : undefined),
      secret: async (orgId, id) =>
        orgId === 7 && id === CREDENTIAL ? { value: "fpk_test" } : undefined,
      renew: async () => {},
    },
    servedModelCost: (model) => {
      servedPriced.push(model);
      return undefined;
    },
    recordUsage: (entry) => usage.push(entry),
    captureError: () => {},
  });
  api = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://api.test");
    if (!(await route(request, url, response))) response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/gateway/v1`;
});

afterAll(async () => {
  await upstream.stop(true);
  await new Promise((resolve) => api.close(resolve));
});

beforeEach(() => {
  calls.length = 0;
  usage.length = 0;
  servedPriced.length = 0;
});

/** A trial key as gateway-trial.ts signs one for the harness. */
function trialKey(harness: "pi" | "codex" | "claude-code"): string {
  const api: CustomEndpointApi | undefined =
    harness === "codex"
      ? "openai-responses"
      : harness === "claude-code"
        ? "anthropic-messages"
        : undefined;
  return signTrialKey(
    {
      orgId: 7,
      credentialId: CREDENTIAL,
      model: MODEL,
      ...(api ? { api } : {}),
      ...(harness === "codex" ? { endpointEffort: true as const } : {}),
      tags: { run: "r1", trial: "t1" },
      expiresAt: Date.now() + 60_000,
    },
    SECRET,
  );
}

async function recorded() {
  for (let attempt = 0; attempt < 100 && usage.length === 0; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return usage;
}

/** One call reached Fireworks' Messages API for the router, on the Fire Pass key as a bearer. */
function expectRouterCall() {
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    path: "/inference/v1/messages",
    authorization: "Bearer fpk_test",
  });
  expect(calls[0]?.body.model).toBe(ROUTER);
}

/** Priced at Kimi Fast's list rates ($4.50 in, $22.50 out per million), not left unpriced. */
async function expectListPriced() {
  expect(await recorded()).toEqual([
    expect.objectContaining({ model: MODEL, status: "completed", costUsd: 27 }),
  ]);
  expect(servedPriced).toEqual([]);
}

test("Pi's Chat Completions reach the router over Messages, thinking at its default", async () => {
  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${trialKey("pi")}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: `dari/model/${MODEL}`,
      stream: true,
      messages: [
        { role: "system", content: "You are a coding agent." },
        { role: "user", content: "hi" },
      ],
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("OK");
  expectRouterCall();
  // A call that names no level thinks, at Kimi's own default, rather than being sent as off.
  expect(calls[0]?.body).toMatchObject({
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
  });
  await expectListPriced();
});

test("Codex's Responses calls, which Fire Pass refuses, reach the router over Messages", async () => {
  const response = await fetch(`${apiUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${trialKey("codex")}`, "content-type": "application/json" },
    // Codex asks a model it has no metadata for for effort "none", which the gateway drops.
    body: JSON.stringify({
      model: `dari/model/${MODEL}`,
      stream: true,
      input: "hi",
      reasoning: { effort: "none" },
    }),
  });
  expect(response.status).toBe(200);
  await response.text();
  expectRouterCall();
  expect(calls[0]?.body).toMatchObject({ output_config: { effort: "high" } });
  await expectListPriced();
});

test("Claude Code reaches the router over Messages at the effort it asks for", async () => {
  const response = await fetch(`${apiUrl}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": trialKey("claude-code"),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: `dari/model/${MODEL}`,
      stream: true,
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("OK");
  expectRouterCall();
  expect(calls[0]?.body).toMatchObject({
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
  });
  await expectListPriced();
});
