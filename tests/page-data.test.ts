import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createResultsSite } from "../src/api/results-site.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import { pageData } from "../src/api/site-body.js";
import type { ReleaseStore } from "../src/db/releases.js";
import type { PublishedLine, ReleaseSetting } from "../src/public/release-types.js";

/** A page's first render reads the API response the page carries, not the API. */
const setting = {
  id: "sol",
  model: { catalogId: "sol", name: "openai/sol", label: "GPT </script> Sol" },
  harness: "codex",
  reasoningLevel: "high",
  provider: "openai",
  signIn: "api-key",
  custom: false,
  tasks: 10,
  passed: 9,
  accuracy: 90,
  costPerTaskUsd: 1,
  totalCostUsd: 10,
  onFrontier: true,
} as ReleaseSetting;
const line: PublishedLine = {
  release: {
    schemaVersion: 1,
    releaseId: "release-1",
    releasedAt: "2026-09-02T00:00:00Z",
    repository: {
      id: 1,
      fullName: "vercel/next.js",
      language: "TypeScript",
      defaultBranch: "main",
      pushedAt: "2026-09-01T00:00:00Z",
    },
    publisher: { login: "acme", kind: "org" },
    tasks: 10,
    settings: [setting],
    frontier: ["sol"],
  },
  endorsed: false,
};

let root: string;
let server: Server;
let base: string;
const get = (path: string) => fetch(`${base}${path}`, { headers: { host: "selfbench.test" } });

/** The block a page carries: its address, and the response parsed. */
async function carried(path: string) {
  const html = await (await get(path)).text();
  const match =
    /<script type="application\/json" id="page-data" data-url="([^"]*)">([^<]*)<\/script>/.exec(
      html,
    );
  return match && { url: match[1], body: JSON.parse(match[2] ?? ""), raw: match[2] ?? "" };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "page-data-"));
  await writeFile(
    join(root, "index.html"),
    '<html><head></head><body><div id="root"></div></body></html>',
  );
  const store = { currentLines: async () => [line] } as unknown as ReleaseStore;
  const site = createResultsSite({
    siteUrl: "https://selfbench.test",
    appUrl: "https://app.selfbench.test",
    indexable: true,
    root,
    publicRoutes: createPublicReleaseRoutes(store),
  });
  server = createServer(async (request, response) => {
    await site.handle(request, new URL(request.url ?? "/", "http://localhost"), response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

test("the home page carries exactly what the directory API answers", async () => {
  const home = await carried("/");
  expect(home?.url).toBe("/api/public/directory");
  expect(home?.body).toEqual(await (await get("/api/public/directory")).json());
});

test("a repository page carries its repository's response, at the address the site asks", async () => {
  const page = await carried("/Vercel/Next.js/acme");
  // The site asks with the path's own spelling (api-source.ts), so the block answers that.
  expect(page?.url).toBe("/api/public/repos/Vercel/Next.js");
  expect(page?.body).toEqual(await (await get("/api/public/repos/vercel/next.js")).json());
});

test("release text cannot close the block, and a page not found carries nothing", async () => {
  const page = await carried("/vercel/next.js");
  expect(page?.raw).not.toContain("</script>");
  expect(page?.body.lines[0].release.settings[0].model.label).toBe("GPT </script> Sol");
  expect(await carried("/nobody/nothing")).toBeNull();
});

test("a response too large to carry is left for the site to fetch", () => {
  expect(pageData("/api/public/directory", "x".repeat(300 * 1024))).toBe("");
  expect(pageData("/api/public/directory", undefined)).toBe("");
});
