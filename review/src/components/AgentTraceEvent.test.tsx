import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentTraceEvent, eventPreview, formatTraceText, parseToolCall } from "./AgentTraceEvent";

test("renders assistant text verbatim with its formatted timestamp", () => {
  const html = renderToStaticMarkup(
    <AgentTraceEvent
      event={{
        kind: "message",
        text: "I checked the implementation.\nThe focused tests pass.",
        timestamp: "2026-02-19T12:34:56.000Z",
      }}
    />,
  );

  expect(html).toContain("12:34:56 PM");
  expect(html).toContain("I checked the implementation.\nThe focused tests pass.");
});

test("labels provider errors before their timestamp", () => {
  const html = renderToStaticMarkup(
    <AgentTraceEvent
      event={{
        kind: "error",
        text: "provider rejected the request",
        timestamp: "2026-02-19T12:34:56.000Z",
      }}
    />,
  );

  expect(html).toContain("Provider Error");
  expect(html).toContain("·</span><time");
  expect(html).toContain("12:34:56 PM");
  expect(html.indexOf("Provider Error")).toBeLessThan(html.indexOf("12:34:56 PM"));
});

test("labels tool calls by tool name with pretty arguments and summarises tool output", () => {
  const call = renderToStaticMarkup(
    <AgentTraceEvent
      event={{ kind: "tool", text: 'bash\n{"command":"bun test","timeout":30000}' }}
    />,
  );
  const result = renderToStaticMarkup(
    <AgentTraceEvent event={{ kind: "result", text: '{"passed":2,"failed":0}' }} />,
  );

  expect(call).toContain("Tool Call");
  expect(call).toContain("· bash");
  expect(call).toContain("Arguments");
  expect(call).toContain("&quot;command&quot;: &quot;bun test&quot;");
  expect(result).toContain("Tool Output");
  expect(result).toContain("passed: 2 · failed: 0");
});

test("formats structured payloads without changing prose or malformed output", () => {
  expect(parseToolCall('read\n{"path":"src/main.ts"}')).toEqual({
    name: "read",
    body: '{"path":"src/main.ts"}',
  });
  expect(formatTraceText('{"nested":{"ok":true}}')).toBe(
    '{\n  "nested": {\n    "ok": true\n  }\n}',
  );
  expect(formatTraceText("plain output\nwith context")).toBe("plain output\nwith context");
  expect(formatTraceText("{not json}")).toBe("{not json}");
  expect(eventPreview('{"items":[1,2,3]}')).toBe("items: [3 items]");
  expect(eventPreview("\n\nfinished successfully\nmore")).toBe("finished successfully");
  expect(eventPreview("", "(no arguments)")).toBe("(no arguments)");
});
