import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { responseCost } from "../src/evaluation/dari/billing.js";

for (const invalid of ['{"usage":{"cost":null}}', '{"usage":{"cost":"bad"}}', "{broken"]) {
  test(`invalid price is persisted before a reader cancellation: ${invalid}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "dari-capture-"));
    const path = join(root, "billing.jsonl");
    const original = globalThis.fetch;
    const previousPath = process.env.SELFBENCH_DARI_BILLING_PATH;
    const require = createRequire(import.meta.url);
    const extension = require.resolve("../src/evaluation/dari/capture.cjs");
    const hooks = new Map<string, () => void>();
    let chunk = 0;
    try {
      process.env.SELFBENCH_DARI_BILLING_PATH = path;
      delete require.cache[extension];
      globalThis.fetch = (async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (chunk < 2)
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: ${chunk++ === 0 ? '{"usage":{"cost":0.02}}' : invalid}\n\n`,
                  ),
                );
              // Deliberately never close: Pi cancels on terminal errors, so flush won't run.
            },
          }),
          { headers: { "content-type": "text/event-stream", "x-request-id": crypto.randomUUID() } },
        )) as unknown as typeof fetch;
      require(extension)({ on: (event: string, handler: () => void) => hooks.set(event, handler) });
      hooks.get("session_start")?.();
      const response = await fetch("https://routing.dari.dev/v1/chat/completions", {
        method: "POST",
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Missing response body");
      await reader.read();
      await reader.read();
      await reader.cancel();
      const bill = await readFile(path, "utf8");
      expect(bill).toContain('"cost":0.02');
      expect(bill).toContain('"cost":null');
      expect(responseCost(bill)).toBeUndefined();
    } finally {
      hooks.get("session_shutdown")?.();
      globalThis.fetch = original;
      if (previousPath === undefined) delete process.env.SELFBENCH_DARI_BILLING_PATH;
      else process.env.SELFBENCH_DARI_BILLING_PATH = previousPath;
      delete require.cache[extension];
      await rm(root, { recursive: true, force: true });
    }
  });
}
