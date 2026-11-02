import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialInfo } from "../../src/db/credentials.js";
import type { TokenUsage } from "../../src/evaluation/types.js";
import { gatewayRoute } from "../../src/gateway/mount.js";
import type { GatewayUsage } from "../../src/gateway/platform.js";
import { type CustomEndpointApi, signTrialKey } from "../../src/gateway/trial-key.js";

// A router behind a Custom Endpoint (Shift-1, Ramp's Router), driven by Codex and Claude Code:
// SelfBench's real gateway handler calls it in the harness's own protocol, and prices each call at
// the list rates of the model its response names, since it returns no price. The router is a
// local stand-in that answers as Shift does: from a model of its own choosing.

const SECRET = "s".repeat(40);
const CREDENTIAL = "8d6b2c4e-1f3a-4b5c-9d7e-0a1b2c3d4e5f";
const MODEL = "custom/shift-1";

interface Call {
  path: string;
  authorization: string | null;
  body: Record<string, unknown>;
}
const calls: Call[] = [];
const usage: GatewayUsage[] = [];
const priced: { model: string; usage: TokenUsage }[] = [];
const errors: string[] = [];
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
    {
      headers: { "content-type": "text/event-stream" },
    },
  );

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const body = (await request.json()) as Record<string, unknown>;
      calls.push({ path, authorization: request.headers.get("authorization"), body });
      if (path === "/v1/responses") {
        const response = {
          id: "resp_1",
          object: "response",
          model: "gpt-6-astra",
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "OK", annotations: [] }],
            },
          ],
          usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 },
        };
        // A router that bills each call reports its price on the response, as Ramp's Router does.
        if (JSON.stringify(body).includes("priced"))
          response.usage = { ...response.usage, cost: 0.0042 } as never;
        return sse([
          {
            type: "response.created",
            response: { ...response, status: "in_progress", output: [] },
          },
          {
            type: "response.output_text.delta",
            item_id: "msg_1",
            output_index: 0,
            content_index: 0,
            delta: "OK",
          },
          { type: "response.completed", response },
        ]);
      }
      if (path === "/v1/messages") {
        return sse([
          {
            type: "message_start",
            message: {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-5-5",
              content: [],
              stop_reason: null,
              usage: { input_tokens: 2000, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 20 },
          },
          { type: "message_stop" },
        ]);
      }
      return new Response("404 page not found", { status: 404 });
    },
  });
  const credential = {
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
        orgId === 7 && id === CREDENTIAL ? { value: "router-key" } : undefined,
      renew: async () => {},
    },
    servedModelCost: (model, tokens) => {
      priced.push({ model, usage: tokens });
      return model === "unlisted" ? undefined : 0.5;
    },
    recordUsage: (entry) => usage.push(entry),
    captureError: (error) => errors.push(String(error)),
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
  priced.length = 0;
});

function trialKey(api: CustomEndpointApi, endpointEffort = false): string {
  return signTrialKey(
    {
      orgId: 7,
      credentialId: CREDENTIAL,
      model: MODEL,
      api,
      ...(endpointEffort ? { endpointEffort: true as const } : {}),
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

test("Codex reaches the router over Responses with no effort, priced as the model that served it", async () => {
  const response = await fetch(`${apiUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${trialKey("openai-responses", true)}`,
      "content-type": "application/json",
    },
    // Codex asks a model it has no metadata for for effort "none", which Shift's models refuse.
    body: JSON.stringify({
      model: `dari/model/${MODEL}`,
      stream: true,
      input: "hi",
      reasoning: { effort: "none" },
    }),
  });
  expect(response.status).toBe(200);
  await response.text();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ path: "/v1/responses", authorization: "Bearer router-key" });
  expect(calls[0]?.body.model).toBe("shift-1");
  expect(calls[0]?.body).not.toHaveProperty("reasoning");
  expect(await recorded()).toEqual([
    expect.objectContaining({
      model: MODEL,
      status: "completed",
      costUsd: 0.5,
      costSource: "pricing",
    }),
  ]);
  expect(priced).toEqual([
    { model: "gpt-6-astra", usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 } },
  ]);
});

test("Claude Code reaches the router over Messages with a bearer key and adaptive thinking", async () => {
  const response = await fetch(`${apiUrl}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": trialKey("anthropic-messages"),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: `dari/model/${MODEL}`,
      stream: true,
      max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 2048 },
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("OK");
  expect(calls).toHaveLength(1);
  // The endpoint is saved as an OpenAI base URL; Anthropic's client appends /v1/messages itself.
  expect(calls[0]).toMatchObject({ path: "/v1/messages", authorization: "Bearer router-key" });
  expect(calls[0]?.body).toMatchObject({
    model: "shift-1",
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
  });
  expect(calls[0]?.body.thinking).not.toHaveProperty("budget_tokens");
  expect(await recorded()).toEqual([
    expect.objectContaining({
      model: MODEL,
      status: "completed",
      costUsd: 0.5,
      costSource: "pricing",
    }),
  ]);
  expect(priced.map((entry) => entry.model)).toEqual(["claude-sonnet-5-5"]);
});

test("a router's reported price is recorded as it reports it, ahead of the list rates", async () => {
  priced.length = 0;
  const response = await fetch(`${apiUrl}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${trialKey("openai-responses", true)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: `dari/model/${MODEL}`, stream: true, input: "priced" }),
  });
  await response.text();
  expect(await recorded()).toEqual([
    expect.objectContaining({
      model: MODEL,
      status: "completed",
      costUsd: 0.0042,
      costSource: "provider",
    }),
  ]);
  expect(priced).toEqual([]);
});
