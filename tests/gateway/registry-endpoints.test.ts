import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialInfo } from "../../src/db/credentials.js";
import {
  customEndpointApi,
  endpointPicksEffort,
  gatewayModelId,
} from "../../src/evaluation/gateway-trial.js";
import type { EvaluationInput } from "../../src/evaluation/types.js";
import { gatewayRoute } from "../../src/gateway/mount.js";
import type { GatewayUsage } from "../../src/gateway/platform.js";
import { signTrialKey } from "../../src/gateway/trial-key.js";
import { servedModelCost } from "../../src/gateways/catalog.js";
import { completionsReply, messagesReply, responsesReply } from "./provider-replies.js";

// Custom Endpoints on the hosts of providers Pi's registry describes: Fireworks (Fire Pass, whose
// `fpk_…` key reaches only its routers, over Chat Completions and Messages but never Responses)
// and Baseten (its Model APIs, and Grid routes, whose auto route picks a model per call).
// SelfBench's real gateway handler serves a model the registry lists as Pi serves it, whichever
// harness calls. Only the providers' hosts are stand-ins, answering as each API does.

const SECRET = "s".repeat(40);
const FIREWORKS = "f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b";
const BASETEN = "b1a2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const KIMI_FAST = "accounts/fireworks/routers/kimi-fast-latest";

interface Call {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}
const calls: Call[] = [];
const usage: GatewayUsage[] = [];
const realFetch = globalThis.fetch;
const credentials: Record<string, CredentialInfo> = {
  // Both saved as their docs give them: each provider's OpenAI base URL.
  [FIREWORKS]: {
    id: FIREWORKS,
    kind: "custom",
    auth: "api-key",
    endpoint: "https://api.fireworks.ai/inference/v1",
  } as CredentialInfo,
  [BASETEN]: {
    id: BASETEN,
    kind: "custom",
    auth: "api-key",
    endpoint: "https://inference.baseten.co/v1",
  } as CredentialInfo,
};
let api: Server;
let apiUrl: string;

beforeAll(async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.host !== "api.fireworks.ai" && url.host !== "inference.baseten.co")
      return realFetch(input, init);
    const body = (await request.json()) as Record<string, unknown>;
    // The address without its query: Anthropic's SDK adds `?beta=true`.
    calls.push({
      url: `${url.origin}${url.pathname}`,
      authorization: request.headers.get("authorization"),
      body,
    });
    if (url.pathname.endsWith("/messages")) return messagesReply(String(body.model));
    // A Grid auto route answers from the model its classifier picked.
    const served = body.model === "acme/auto" ? "zai-org/GLM-5.3" : String(body.model);
    if (url.pathname.endsWith("/responses")) return responsesReply(served);
    return completionsReply(served);
  }) as typeof fetch;
  const route = gatewayRoute({
    secret: SECRET,
    endpoint: (endpoint) => endpoint,
    credentials: {
      find: async (orgId, id) => (orgId === 7 ? credentials[id] : undefined),
      secret: async (orgId, id) =>
        orgId === 7 && credentials[id]
          ? { value: id === FIREWORKS ? "fpk_test" : "baseten-key" }
          : undefined,
      renew: async () => {},
    },
    servedModelCost,
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

type Harness = "pi" | "codex" | "claude-code";

/** A trial key as trial-setup.ts signs one for the harness on the custom endpoint. */
function trialKey(harness: Harness, credentialId: string, model: string): string {
  const input = {
    credentials: { provider: "custom" },
    modelName: `openai/${model}`,
  } as Pick<EvaluationInput, "credentials" | "modelName">;
  const endpoint = credentials[credentialId]?.endpoint;
  return signTrialKey(
    {
      orgId: 7,
      credentialId,
      model: gatewayModelId(input),
      ...customEndpointApi(input, harness),
      ...(endpointPicksEffort(input, harness, endpoint) ? { endpointEffort: true as const } : {}),
      tags: { run: "r1", trial: "t1" },
      expiresAt: Date.now() + 60_000,
    },
    SECRET,
  );
}

/** One call from the harness, in its own protocol, as the gateway's ingress takes it. */
async function call(harness: Harness, credentialId: string, model: string) {
  const key = trialKey(harness, credentialId, model);
  const name = `dari/model/custom/${model}`;
  const request =
    harness === "pi"
      ? {
          path: "chat/completions",
          headers: { authorization: `Bearer ${key}` },
          body: {
            model: name,
            stream: true,
            messages: [
              { role: "system", content: "You are a coding agent." },
              { role: "user", content: "hi" },
            ],
          },
        }
      : harness === "codex"
        ? {
            path: "responses",
            headers: { authorization: `Bearer ${key}` },
            // Codex asks a model it has no metadata for for effort "none", which is dropped.
            body: { model: name, stream: true, input: "hi", reasoning: { effort: "none" } },
          }
        : {
            path: "messages",
            headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
            body: {
              model: name,
              stream: true,
              max_tokens: 4096,
              thinking: { type: "adaptive" },
              output_config: { effort: "medium" },
              messages: [{ role: "user", content: "hi" }],
            },
          };
  const response = await fetch(`${apiUrl}/${request.path}`, {
    method: "POST",
    headers: { ...request.headers, "content-type": "application/json" },
    body: JSON.stringify(request.body),
  });
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).toContain("OK");
  expect(calls).toHaveLength(1);
  return calls[0] as Call;
}

async function recordedCost() {
  for (let attempt = 0; attempt < 100 && usage.length === 0; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(usage).toHaveLength(1);
  return usage[0]?.costUsd;
}

for (const harness of ["pi", "codex", "claude-code"] as const)
  test(`${harness} reaches a Fire Pass router over Fireworks' Messages API, at list price`, async () => {
    const sent = await call(harness, FIREWORKS, KIMI_FAST);
    // Codex's Responses call too: Fire Pass refuses Responses.
    expect(sent).toMatchObject({
      url: "https://api.fireworks.ai/inference/v1/messages",
      authorization: "Bearer fpk_test",
    });
    expect(sent.body).toMatchObject({ model: KIMI_FAST, thinking: { type: "adaptive" } });
    // Every call thinks at Kimi's own default, rather than going out as off (Pi names no level)
    // or at whatever its harness asked (Claude Code's medium).
    expect(sent.body.output_config).toEqual({ effort: "high" });
    // Kimi Fast lists at $4.50 in and $22.50 out per million tokens.
    expect(await recordedCost()).toBe(27);
  });

for (const harness of ["pi", "codex", "claude-code"] as const)
  test(`${harness} reaches a Baseten Model API over its Chat Completions, as Pi's registry sets it`, async () => {
    const sent = await call(harness, BASETEN, "zai-org/GLM-5.3");
    expect(sent).toMatchObject({
      url: "https://inference.baseten.co/v1/chat/completions",
      authorization: "Bearer baseten-key",
    });
    expect(sent.body.model).toBe("zai-org/GLM-5.3");
    // Baseten's settings, which an unknown endpoint would not get: `max_tokens`, no developer role.
    expect(sent.body).toHaveProperty("max_tokens");
    expect(sent.body).not.toHaveProperty("max_completion_tokens");
    const roles = (sent.body.messages as { role: string }[]).map((message) => message.role);
    expect(roles).not.toContain("developer");
    // GLM 5.3 lists at $1.40 in and $4.40 out per million tokens.
    expect(await recordedCost()).toBeCloseTo(5.8);
  });

test("a Baseten Grid auto route is called in the harness's protocol and priced as its pick", async () => {
  const sent = await call("codex", BASETEN, "acme/auto");
  expect(sent).toMatchObject({
    url: "https://inference.baseten.co/v1/responses",
    authorization: "Bearer baseten-key",
  });
  expect(sent.body.model).toBe("acme/auto");
  // The route answered from GLM 5.3, which Baseten lists at $1.40 in and $4.40 out per million.
  expect(await recordedCost()).toBeCloseTo(5.8);
});

test("a model Pi's registry lists elsewhere is not taken as that provider's on another host", async () => {
  // Fireworks' id on Baseten's host: Baseten does not list it, so it is called as given.
  const sent = await call("pi", BASETEN, KIMI_FAST);
  expect(sent.url).toBe("https://inference.baseten.co/v1/chat/completions");
  expect(await recordedCost()).toBeNull();
});
