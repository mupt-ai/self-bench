import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialInfo } from "../../src/db/credentials.js";
import { gatewayRoute } from "../../src/gateway/mount.js";
import type { GatewayUsage } from "../../src/gateway/platform.js";
import { signTrialKey } from "../../src/gateway/trial-key.js";

// A Dari credential on Codex or Claude Code: SelfBench's real gateway handler takes the harness's
// Responses or Messages call and serves it from the router the credential names, over Dari's Chat
// Completions, recording the price Dari returned. Only Dari's host is a stand-in.

const SECRET = "s".repeat(40);
const CREDENTIAL = "8d6b2c4e-1f3a-4b5c-9d7e-0a1b2c3d4e5f";
const ROUTER = "https://routing.dari.dev/rtr_e2e0c8cbf46cab1b325ec0";

const calls: { url: string; authorization: string | null; body: Record<string, unknown> }[] = [];
const usage: GatewayUsage[] = [];
const realFetch = globalThis.fetch;
let api: Server;
let apiUrl: string;

beforeAll(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).host !== "routing.dari.dev") return realFetch(input, init);
    calls.push({
      url: request.url,
      authorization: request.headers.get("authorization"),
      body: await request.json(),
    });
    const chunk = (fields: object) =>
      `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "openai/gpt-6-luna", ...fields })}\n\n`;
    return new Response(
      chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "OK" } }] }) +
        chunk({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 19, completion_tokens: 5, total_tokens: 24, cost: 0.0042 },
        }) +
        "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch;
  const credential = {
    id: CREDENTIAL,
    kind: "dari",
    auth: "api-key",
    endpoint: ROUTER,
  } as CredentialInfo;
  const route = gatewayRoute({
    secret: SECRET,
    endpoint: () => {
      throw new Error("A Dari router is not a custom endpoint");
    },
    credentials: {
      find: async (orgId, id) => (orgId === 7 && id === CREDENTIAL ? credential : undefined),
      secret: async (orgId, id) =>
        orgId === 7 && id === CREDENTIAL ? { value: "dari-key" } : undefined,
      renew: async () => {},
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
  globalThis.fetch = realFetch;
  await new Promise((resolve) => api.close(resolve));
});

beforeEach(() => {
  calls.length = 0;
  usage.length = 0;
});

function trialKey(api?: "openai-responses"): string {
  return signTrialKey(
    {
      orgId: 7,
      credentialId: CREDENTIAL,
      model: "dari/routing",
      tags: { run: "r1", trial: "t1" },
      expiresAt: Date.now() + 60_000,
      ...(api ? { api } : {}),
    },
    SECRET,
  );
}

async function served(response: Response) {
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("OK");
  for (let attempt = 0; attempt < 100 && usage.length === 0; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  // Chat Completions on the named router, on the credential's key, with no `reasoning` field,
  // which Dari refuses: the router picks each call's effort.
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    url: `${ROUTER}/chat/completions`,
    authorization: "Bearer dari-key",
    body: { model: "dari/routing" },
  });
  expect(calls[0]?.body).not.toHaveProperty("reasoning");
  expect(usage).toEqual([
    expect.objectContaining({
      credentialId: CREDENTIAL,
      model: "dari/routing",
      status: "completed",
      costUsd: 0.0042,
      costSource: "provider",
    }),
  ]);
}

test("Codex's Responses call reaches the credential's router and records Dari's price", async () => {
  await served(
    await fetch(`${apiUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${trialKey("openai-responses")}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "dari/model/dari/routing", stream: true, input: "hi" }),
    }),
  );
});

test("Claude Code's Messages call reaches the credential's router and records Dari's price", async () => {
  await served(
    await fetch(`${apiUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": trialKey(),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "dari/model/dari/routing",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );
});
