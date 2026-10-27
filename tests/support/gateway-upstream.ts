// A stand-in for the providers the trial path reaches (OpenAI, Anthropic, OpenRouter and Meta, and
// ChatGPT's Codex backend and Anthropic for Claude sign-ins), each speaking its own wire protocol and
// streaming a real reply. It checks the key a provider would be sent, so a request carrying the
// trial's key (rather than the vault's) fails with 401.

/** An unsigned JWT for a ChatGPT account, as a Codex sign-in's access token, valid for an hour. */
const codexAccess = `h.${Buffer.from(
  JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  }),
).toString("base64url")}.s`;

export const VAULT_SECRETS = {
  openai: "vault-openai-key-111",
  anthropic: "vault-anthropic-key-222",
  openrouter: "vault-openrouter-key-333",
  meta: "vault-meta-key-444",
  "claude-login": "sk-ant-oat01-vault-claude-555",
  "codex-login": JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: codexAccess, refresh_token: "vault-refresh-666", account_id: "acct-1" },
  }),
} as const;

/** The bearer token each credential reaches its provider with. */
export const UPSTREAM_KEYS = {
  ...VAULT_SECRETS,
  "codex-login": codexAccess,
} as const;

export interface UpstreamCall {
  path: string;
  authorization: string | null;
  xApiKey: string | null;
  model: string;
}

/** Server-sent events in a provider's own framing. */
function sse(events: [event: string | null, data: unknown][]): Response {
  const body = events
    .map(([event, data]) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`)
    .join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function responsesStream(model: string): Response {
  const text = `served by ${model}`;
  const usage = {
    input_tokens: 8,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 11,
  };
  const message = { type: "message", id: "msg_1", role: "assistant", status: "completed" };
  return sse([
    [
      "response.created",
      {
        type: "response.created",
        sequence_number: 0,
        response: { id: "resp_1", object: "response", model, status: "in_progress", output: [] },
      },
    ],
    [
      "response.output_item.added",
      {
        type: "response.output_item.added",
        sequence_number: 1,
        output_index: 0,
        item: { ...message, status: "in_progress", content: [] },
      },
    ],
    [
      "response.content_part.added",
      {
        type: "response.content_part.added",
        sequence_number: 2,
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
    ],
    [
      "response.output_text.delta",
      {
        type: "response.output_text.delta",
        sequence_number: 3,
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: text,
      },
    ],
    [
      "response.output_text.done",
      {
        type: "response.output_text.done",
        sequence_number: 4,
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        text,
      },
    ],
    [
      "response.output_item.done",
      {
        type: "response.output_item.done",
        sequence_number: 5,
        output_index: 0,
        item: { ...message, content: [{ type: "output_text", text, annotations: [] }] },
      },
    ],
    [
      "response.completed",
      {
        type: "response.completed",
        sequence_number: 6,
        response: {
          id: "resp_1",
          object: "response",
          model,
          status: "completed",
          output: [{ ...message, content: [{ type: "output_text", text, annotations: [] }] }],
          usage,
        },
      },
    ],
  ]);
}

function messagesStream(model: string): Response {
  return sse([
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 8,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `served by ${model}` },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 3 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);
}

function completionStream(model: string): Response {
  const usage = {
    prompt_tokens: 8,
    completion_tokens: 3,
    total_tokens: 11,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    cost: 0.0123,
  };
  const chunk = (fields: object) =>
    `data: ${JSON.stringify({ id: "gen-1", object: "chat.completion.chunk", model, ...fields })}\n\n`;
  const body = [
    chunk({
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: `served by ${model}` },
          finish_reason: null,
        },
      ],
    }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    chunk({ choices: [], usage }),
    "data: [DONE]\n\n",
  ].join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Starts the stand-in on a free local port, recording each call it receives. */
export function startUpstream() {
  const calls: UpstreamCall[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      // Pi tries Codex's backend over a WebSocket first, then falls back to HTTPS.
      if (request.method !== "POST") return new Response("not found", { status: 404 });
      // Pi compresses its requests to Codex's backend, as Codex does.
      const raw = new Uint8Array(await request.arrayBuffer());
      const text =
        request.headers.get("content-encoding") === "zstd" ? Bun.zstdDecompressSync(raw) : raw;
      const body = JSON.parse(new TextDecoder().decode(text)) as { model: string };
      const authorization = request.headers.get("authorization");
      const xApiKey = request.headers.get("x-api-key");
      calls.push({ path: url.pathname, authorization, xApiKey, model: body.model });
      const denied = () => new Response("bad key", { status: 401 });
      const bearer = (key: string) => authorization === `Bearer ${key}`;
      if (url.pathname === "/v1/responses")
        return bearer(VAULT_SECRETS.openai) || bearer(VAULT_SECRETS.meta)
          ? responsesStream(body.model)
          : denied();
      if (url.pathname === "/codex/responses")
        return bearer(UPSTREAM_KEYS["codex-login"]) ? responsesStream(body.model) : denied();
      if (url.pathname === "/v1/messages")
        return xApiKey === VAULT_SECRETS.anthropic || bearer(VAULT_SECRETS["claude-login"])
          ? messagesStream(body.model)
          : denied();
      if (url.pathname === "/api/v1/chat/completions")
        return authorization === `Bearer ${VAULT_SECRETS.openrouter}`
          ? completionStream(body.model)
          : denied();
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    calls,
    /** The base URL each vendor's credential points the gateway at (the stand-in's wire path). */
    base: {
      openai: `${url}/v1`,
      anthropic: url,
      openrouter: `${url}/api/v1`,
      meta: `${url}/v1`,
      "claude-login": url,
      "codex-login": url,
    } as const,
    stop: () => server.stop(true),
  };
}
