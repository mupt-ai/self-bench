import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { sendTagged, tagged } from "../src/api/tagged.js";

const large = tagged(`<html>${"a benchmark page ".repeat(200)}</html>`);
const small = tagged("<p>tiny</p>");
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((request, response) =>
    sendTagged(request, response, request.url === "/small" ? small : large, {
      "cache-control": "public, max-age=60",
      "content-type": "text/html; charset=utf-8",
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});

/** Fetches without the client decompressing, so the bytes on the wire can be checked. */
const get = (path: string, headers: Record<string, string>) =>
  fetch(`${base}${path}`, { headers, decompress: false } as RequestInit);

test("a body is compressed here, brotli first, each encoding with its own tag", async () => {
  const br = await get("/", { "accept-encoding": "gzip, br" });
  expect(br.headers.get("content-encoding")).toBe("br");
  expect(br.headers.get("vary")).toBe("Accept-Encoding");
  expect(br.headers.get("etag")).toBe(`${large.etag.slice(0, -1)}-br"`);
  expect(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).toBe(large.body);

  const gzip = await get("/", { "accept-encoding": "gzip, br;q=0" });
  expect(gzip.headers.get("content-encoding")).toBe("gzip");
  expect(gzip.headers.get("etag")).toBe(`${large.etag.slice(0, -1)}-gzip"`);
  expect(gunzipSync(Buffer.from(await gzip.arrayBuffer())).toString()).toBe(large.body);

  const plain = await get("/", { "accept-encoding": "identity" });
  expect(plain.headers.get("content-encoding")).toBeNull();
  expect(plain.headers.get("etag")).toBe(large.etag);
  expect(await plain.text()).toBe(large.body);
});

test("a client holding an encoding's tag gets a bodyless 304 for that encoding", async () => {
  const etag = (await get("/", { "accept-encoding": "br" })).headers.get("etag") ?? "";
  const again = await get("/", { "accept-encoding": "br", "if-none-match": etag });
  expect(again.status).toBe(304);
  expect(again.headers.get("vary")).toBe("Accept-Encoding");
  expect(await again.text()).toBe("");
  // Another encoding's bytes differ, so its tag does not match.
  expect((await get("/", { "accept-encoding": "gzip", "if-none-match": etag })).status).toBe(200);
});

test("small bodies are sent as they are", async () => {
  const response = await get("/small", { "accept-encoding": "br, gzip" });
  expect(response.headers.get("content-encoding")).toBeNull();
  expect(response.headers.get("etag")).toBe(small.etag);
  expect(await response.text()).toBe(small.body);
});
