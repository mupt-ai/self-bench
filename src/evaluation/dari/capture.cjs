// Pi's catalog cannot price a router. Retain Dari's OpenRouter-compatible usage.cost instead.
const { appendFileSync } = require("node:fs");
const ledger = process.env.SELFBENCH_DARI_BILLING_PATH ?? "/logs/agent/dari-billing.jsonl";
module.exports = function (pi) {
  let sequence = 0;
  const write = (event) => appendFileSync(ledger, JSON.stringify(event) + "\n", { mode: 0o600 });
  let originalFetch;
  let capturedFetch;
  pi.on("session_start", () => {
    originalFetch = globalThis.fetch;
    capturedFetch = globalThis.fetch = async function (input, init) {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (
        url.origin !== "https://routing.dari.dev" ||
        method.toUpperCase() !== "POST" ||
        !url.pathname.endsWith("/chat/completions")
      )
        return originalFetch(input, init);
      const index = ++sequence;
      write({ type: "request", index });
      const response = await originalFetch(input, init);
      const requestId = response.headers.get("x-request-id");
      let cost = null;
      let invalid = false;
      let pending = "";
      const invalidate = () => {
        invalid = true;
        write({ type: "cost", index, requestId, cost: null });
      };
      const decoder = new TextDecoder();
      const streaming = response.headers.get("content-type")?.includes("text/event-stream");
      const observe = (text) => {
        if (!text || text === "[DONE]") return;
        try {
          const data = JSON.parse(text);
          if (!data.usage || !("cost" in data.usage)) return;
          const value = data.usage.cost;
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
            invalidate();
            return;
          }
          if (cost !== null && cost !== value) invalid = true;
          cost = value;
          // Persist before Pi handles a terminal error and cancels its reader.
          write({ type: "cost", index, requestId, cost: invalid ? null : cost });
        } catch {
          invalidate();
        }
      };
      const consume = (text, end = false) => {
        pending += text;
        if (streaming) {
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) if (line.startsWith("data:")) observe(line.slice(5).trim());
          if (end && pending.startsWith("data:")) observe(pending.slice(5).trim());
        } else if (end) observe(pending);
        // Stream deltas can be large, but never retain an unbounded line or JSON body.
        if (pending.length > 16 * 1024 * 1024) {
          invalidate();
          pending = "";
        }
      };
      if (!response.body) return response;
      const body = response.body.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            consume(decoder.decode(chunk, { stream: true }));
            controller.enqueue(chunk);
          },
          flush() {
            consume(decoder.decode(), true);
            if (invalid || cost === null) write({ type: "cost", index, requestId, cost: null });
          },
        }),
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  });
  pi.on("session_shutdown", () => {
    if (globalThis.fetch === capturedFetch) globalThis.fetch = originalFetch;
  });
};
