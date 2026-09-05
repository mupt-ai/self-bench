import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFeedEvents } from "../src/agent-feed.js";
import { LocalArtifactStore } from "../src/artifacts.js";
import { PiEventFeed } from "../src/pi-event-feed.js";
import { withAgentFeed } from "../src/temporal/activities/agent-feed.js";

const line = (event: unknown) => Buffer.from(`${JSON.stringify(event)}\n`);

test("native Pi deltas survive chunk boundaries, replace cumulative tool output and omit reasoning", () => {
  const feed = new PiEventFeed(["sensitive-secret"]);
  const bytes = Buffer.concat([
    line({ type: "message_start", message: { role: "assistant" } }),
    line({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "private" },
    }),
    line({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "Checking café sensitive-" },
    }),
    line({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "secret" },
    }),
    line({
      type: "tool_execution_start",
      toolCallId: "a",
      toolName: "bash",
      args: { command: "bun test" },
    }),
    line({
      type: "tool_execution_update",
      toolCallId: "a",
      partialResult: { content: [{ type: "text", text: "1 pass" }] },
    }),
    line({
      type: "tool_execution_end",
      toolCallId: "a",
      result: { content: [{ type: "text", text: "2 pass" }] },
    }),
  ]);
  for (const byte of bytes) feed.push(Uint8Array.of(byte));
  expect(feed.events()).toEqual([
    { kind: "message", text: "Checking café [REDACTED]" },
    { kind: "tool", text: 'bash\n{\n  "command": "bun test"\n}' },
    { kind: "result", text: "2 pass" },
  ]);
});

test("final messages replace streamed text and oversized input cannot poison the next event", () => {
  const feed = new PiEventFeed();
  feed.push(Buffer.from("x".repeat(1048577)));
  feed.push(Buffer.from("\n"));
  feed.push(
    line({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "partial" },
    }),
  );
  feed.push(
    line({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "complete" }] },
    }),
  );
  expect(feed.events()).toEqual([{ kind: "message", text: "complete" }]);
});

test("archived conversations redact credentials and omit prompts and reasoning", () => {
  const text = [
    { message: { role: "user", content: [{ type: "text", text: "prompt" }] } },
    {
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private" },
          { type: "text", text: "token=oauth-secret-value" },
        ],
      },
    },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");
  expect(agentFeedEvents(text, ['{"access":"oauth-secret-value"}'])).toEqual([
    { kind: "message", text: "token=[REDACTED]" },
  ]);
});

test("feed flushes on completion and failure without starting a sandbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-feed-"));
  const store = new LocalArtifactStore(root);
  try {
    const result = await withAgentFeed(store, "round-1/attempt-1", [], async (output) => {
      output(
        "stdout",
        line({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Working" },
        }),
      );
      return 42;
    });
    expect(result).toBe(42);
    const saved = await store.getByKey("round-1/attempt-1/live/00000000.json");
    expect(JSON.parse(Buffer.from(saved ?? []).toString()).events).toEqual([
      { kind: "message", text: "Working" },
    ]);
    await expect(
      withAgentFeed(store, "round-2/attempt-1", [], async (output) => {
        output("stdout", line({ type: "tool_execution_start", toolCallId: "a", toolName: "bash" }));
        throw new Error("sandbox failed");
      }),
    ).rejects.toThrow("sandbox failed");
    expect(await store.getByKey("round-2/attempt-1/live/00000000.json")).toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
