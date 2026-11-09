import { expect, test } from "bun:test";
import { homeBody } from "../src/api/site-body.js";
import { homeHead } from "../src/api/site-head.js";
import { sitemapOf } from "../src/api/sitemap.js";
import type { PublishedLine, ReleaseSetting } from "../src/public/release-types.js";
import { DIRECTORY_VIEWS, directoryViewAt } from "../src/public/seo.js";

const origin = "https://selfbench.dev";

const sol = {
  id: "sol",
  model: { catalogId: "sol", name: "openai/sol", label: "GPT-6 Sol" },
  harness: "codex",
  reasoningLevel: "high",
  provider: "openai",
  signIn: "api-key",
  custom: false,
  tasks: 4,
  passed: 3,
  accuracy: 75,
  costPerTaskUsd: 1,
  totalCostUsd: 4,
  onFrontier: true,
} as ReleaseSetting;

const line = (fullName: string, releasedAt: string): PublishedLine => ({
  release: {
    schemaVersion: 1,
    releaseId: `${fullName}@${releasedAt}`,
    releasedAt,
    repository: { id: fullName.length, fullName },
    publisher: { login: "acme", kind: "org" },
    tasks: 4,
    settings: [sol],
    frontier: ["sol"],
  },
  endorsed: false,
});

const repository = line("vercel/next.js", "2026-09-02T00:00:00Z");
// Its own row's id, which here equals the repository's GitHub id: both are still listed.
const terminal = line("evals/terminal", "2026-09-04T00:00:00Z");

test("repositories and evals are separate views of the directory, each its own page", () => {
  expect(directoryViewAt("/")).toBe("repositories");
  expect(directoryViewAt("/evals")).toBe("evals");
  expect(directoryViewAt("/evals/terminal")).toBeUndefined();

  const home = homeBody([[repository], [terminal]]);
  expect(home).toContain(`<h1>${DIRECTORY_VIEWS.repositories.heading}</h1>`);
  expect(home).toContain('<a href="/vercel/next.js">');
  expect(home).not.toContain('<a href="/evals/terminal">');

  const evals = homeBody([[repository], [terminal]], [], "evals");
  expect(evals.split("<h1").length - 1).toBe(1);
  expect(evals).toContain(`<h1>${DIRECTORY_VIEWS.evals.heading}</h1>`);
  expect(evals).toContain('<a href="/evals/terminal">');
  expect(evals).not.toContain('<a href="/vercel/next.js">');
  // Both link to both, so a crawler finds each view.
  for (const html of [home, evals])
    expect(html).toContain('<nav><a href="/">Repositories</a> <a href="/evals">Evals</a></nav>');
});

test("the evals page has its own head, and joins the sitemap once there is an eval", () => {
  expect(homeHead(origin, "evals")).toEqual({
    title: DIRECTORY_VIEWS.evals.title,
    description: DIRECTORY_VIEWS.evals.description,
    canonical: `${origin}/evals`,
  });
  expect(DIRECTORY_VIEWS.evals.description.length).toBeLessThanOrEqual(160);
  expect(sitemapOf(origin, [[repository]])).not.toContain("/evals<");
  expect(sitemapOf(origin, [[repository], [terminal]])).toContain(
    `<url><loc>${origin}/evals</loc><lastmod>2026-09-04T00:00:00Z</lastmod></url>`,
  );
});
