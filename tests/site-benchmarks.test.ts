import { expect, test } from "bun:test";
import { snapshotOf } from "../src/api/public-snapshot.js";
import { homeBody, repositoryBody } from "../src/api/site-body.js";
import { homeHead, repositoryHead } from "../src/api/site-head.js";
import { sitemapOf } from "../src/api/sitemap.js";
import { directoryOf } from "../src/public/directory.js";
import { repositoryPath } from "../src/public/paths.js";
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

const line = (
  fullName: string,
  publisher: string,
  releasedAt: string,
  benchmark?: { ref: string },
): PublishedLine => ({
  release: {
    schemaVersion: 1,
    releaseId: `${fullName}/${publisher}@${releasedAt}`,
    releasedAt,
    repository: { id: 7, fullName },
    publisher: { login: publisher, kind: "org" },
    tasks: 4,
    settings: [sol],
    frontier: ["sol"],
    ...(benchmark ? { benchmark } : {}),
  },
  endorsed: false,
});

// A GitHub repository and a public benchmark of the same name, and the benchmark run by two
// workspaces, whose benchmark rows (and so ids) are their own.
const repository = line("laude-institute/terminal-bench", "acme", "2026-09-02T00:00:00Z");
const acme = line("laude-institute/terminal-bench", "acme", "2026-09-04T00:00:00Z", {
  ref: "2.0",
});
const marco = line("laude-institute/terminal-bench", "marco", "2026-09-03T00:00:00Z", {
  ref: "2.0",
});

test("a public benchmark's pages live under /evals, apart from a repository of the same name", () => {
  expect(repositoryPath(["evals", "laude-institute", "terminal-bench"])).toEqual({
    owner: "laude-institute",
    name: "terminal-bench",
    benchmark: true,
  });
  expect(repositoryPath(["evals", "laude-institute", "terminal-bench", "marco"])).toMatchObject({
    publisher: "marco",
    benchmark: true,
  });
  expect(repositoryPath(["laude-institute", "terminal-bench"])).toEqual({
    owner: "laude-institute",
    name: "terminal-bench",
  });

  const snapshot = snapshotOf(
    [repository.release, acme.release, marco.release].map((release) => ({
      release,
      endorsed: false,
    })),
  );
  expect(snapshot.byRepository.get("laude-institute/terminal-bench")).toHaveLength(1);
  expect(snapshot.byRepository.get("evals/laude-institute/terminal-bench")).toHaveLength(2);

  // One card each by default: the repository's, and the benchmark's newest line.
  const cards = directoryOf([repository, acme, marco]).filter((card) => card.defaultLine);
  expect(
    cards.map((card) => [card.repository.fullName, card.publisher.login, !!card.benchmark]),
  ).toEqual([
    ["laude-institute/terminal-bench", "acme", true],
    ["laude-institute/terminal-bench", "acme", false],
  ]);
});

test("the directory's views split repositories from public benchmarks", () => {
  expect(directoryViewAt("/")).toBe("repositories");
  expect(directoryViewAt("/evals")).toBe("benchmarks");

  const home = homeBody([[repository], [acme, marco]]);
  expect(home).toContain(`<h1>${DIRECTORY_VIEWS.repositories.heading}</h1>`);
  expect(home).toContain('<a href="/laude-institute/terminal-bench">');
  expect(home).not.toContain('<a href="/evals/laude-institute/terminal-bench">');

  const benchmarks = homeBody([[repository], [acme, marco]], [], "benchmarks");
  expect(benchmarks.split("<h1").length - 1).toBe(1);
  expect(benchmarks).toContain(`<h1>${DIRECTORY_VIEWS.benchmarks.heading}</h1>`);
  expect(benchmarks).toContain('<a href="/evals/laude-institute/terminal-bench">');
  expect(benchmarks).not.toContain('<a href="/laude-institute/terminal-bench">');
  for (const html of [home, benchmarks])
    expect(html).toContain(
      '<nav><a href="/">Repositories</a> <a href="/evals">Public Benchmarks</a></nav>',
    );
});

test("a public benchmark's page links its lines, and names no repository", () => {
  const head = repositoryHead(origin, [acme, marco], "marco");
  expect(head?.canonical).toBe(`${origin}/evals/laude-institute/terminal-bench/marco`);
  const data = JSON.stringify(head?.structuredData);
  expect(data).not.toContain("codeRepository");
  expect(data).not.toContain("pull requests");
  expect(data).toContain('"name":"Public Benchmarks","item":"https://selfbench.dev/evals"');
  // The full description, which the 160-character one shortens.
  expect(data).toContain("scored on 4 tasks from the benchmark.");
  const body = repositoryBody([acme, marco], "marco") ?? "";
  expect(body).toContain('<a href="/evals/laude-institute/terminal-bench">acme</a>');
  expect(homeHead(origin, "benchmarks").canonical).toBe(`${origin}/evals`);
  expect(DIRECTORY_VIEWS.benchmarks.description.length).toBeLessThanOrEqual(160);
});

test("the sitemap lists the benchmarks' pages, and their view once there is one", () => {
  expect(sitemapOf(origin, [[repository]])).not.toContain("/evals<");
  const sitemap = sitemapOf(origin, [[repository], [acme, marco]]);
  expect(sitemap).toContain(
    `<url><loc>${origin}/evals</loc><lastmod>2026-09-04T00:00:00Z</lastmod></url>`,
  );
  expect(sitemap).toContain(`<loc>${origin}/evals/laude-institute/terminal-bench</loc>`);
  expect(sitemap).toContain(`<loc>${origin}/evals/laude-institute/terminal-bench/marco</loc>`);
  expect(sitemap).toContain(`<loc>${origin}/laude-institute/terminal-bench</loc>`);
  // The home page lists the repository alone, so it is dated by the repository's release.
  expect(sitemap).toContain(
    `<url><loc>${origin}/</loc><lastmod>2026-09-02T00:00:00Z</lastmod></url>`,
  );
});
