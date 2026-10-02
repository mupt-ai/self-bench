import { afterEach, expect, test } from "bun:test";
import { EvaluationRequestError, runsRequest } from "./api";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function responses(...items: Response[]) {
  const sent: (string | null)[] = [];
  globalThis.fetch = (async (_url, init) => {
    sent.push(new Headers(init?.headers).get("if-none-match"));
    const response = items.shift();
    if (!response) throw new Error("Unexpected request");
    return response;
  }) as typeof fetch;
  return sent;
}

test("a poll sends the tag of the list it has, and an unchanged list is not downloaded", async () => {
  const sent = responses(
    Response.json({ runs: [{ id: "one" }] }, { headers: { etag: '"first"' } }),
    new Response(null, { status: 304, headers: { etag: '"first"' } }),
    Response.json({ runs: [] }),
  );
  const first = await runsRequest("/evaluations");
  expect(first).toEqual({ runs: [{ id: "one" }], tag: '"first"' } as never);
  expect(await runsRequest("/evaluations", first?.tag)).toBeUndefined();
  // A server that sends no tag is simply asked for the whole list each time.
  expect(await runsRequest("/evaluations", first?.tag)).toEqual({ runs: [] });
  expect(sent).toEqual([null, '"first"', '"first"']);
});

test("a failed list is an error, not an unchanged one", async () => {
  responses(Response.json({ error: "Repository is not connected here" }, { status: 404 }));
  await expect(runsRequest("/evaluations", '"first"')).rejects.toBeInstanceOf(
    EvaluationRequestError,
  );
});
