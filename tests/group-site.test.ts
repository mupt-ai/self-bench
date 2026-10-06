import { expect, test } from "bun:test";
import { cardPng } from "../src/api/link-card.js";
import { createPublicReleaseRoutes } from "../src/api/routes/public-releases.js";
import { homeBody } from "../src/api/site-body.js";
import { groupBody, groupHead } from "../src/api/site-group.js";
import { sitemapOf } from "../src/api/site-head.js";
import { sitePages } from "../src/api/site-pages.js";
import type { GroupReleaseStore } from "../src/db/group-releases.js";
import type { ReleaseStore } from "../src/db/releases.js";
import type { PublishedGroupRelease, ReleaseSetting } from "../src/public/release-types.js";

const origin = "https://selfbench.dev";

const setting = (id: string, label: string, accuracy: number, costPerTaskUsd: number) =>
  ({
    id,
    model: { catalogId: id, name: `openai/${id}`, label },
    harness: "codex",
    reasoningLevel: "high",
    provider: "openai",
    custom: false,
    tasks: 5,
    passed: Math.round((accuracy / 100) * 5),
    accuracy,
    costPerTaskUsd,
    totalCostUsd: costPerTaskUsd * 5,
    onFrontier: true,
  }) as ReleaseSetting;

const release: PublishedGroupRelease = {
  schemaVersion: 1,
  releaseId: "00000000-0000-4000-8000-000000000001",
  releasedAt: "2026-10-01T00:00:00Z",
  group: {
    slug: "nextjs-apps",
    name: "Next.js Apps",
    members: [
      { id: 1, fullName: "calcom/cal.com" },
      { id: 2, fullName: "dubinc/dub" },
      { id: 3, fullName: "vercel/commerce" },
    ],
  },
  publisher: { login: "acme", kind: "org" },
  tasks: 5,
  settings: [setting("sol", "GPT-6 Sol", 80, 1.5), setting("luna", "GPT-6 Luna", 60, 0.4)],
  frontier: ["sol", "luna"],
  breakdown: [
    {
      repositoryId: 1,
      tasks: 3,
      settings: [{ id: "sol", passed: 3, accuracy: 100, costPerTaskUsd: 1, totalCostUsd: 3 }],
    },
    {
      repositoryId: 2,
      tasks: 2,
      settings: [{ id: "sol", passed: 1, accuracy: 50, costPerTaskUsd: 2.25, totalCostUsd: 4.5 }],
    },
  ],
};

test("a group's head names it, its repositories, and its own address and card", () => {
  const head = groupHead(origin, release);
  expect(head.title).toBe("Next.js Apps: Multi-Repo Coding Agent Benchmark · SelfBench");
  expect(head.description).toStartWith(
    "Which coding agent works best across calcom/cal.com, dubinc/dub and 1 more? Most accurate: GPT-6 Sol",
  );
  expect(head.description.length).toBeLessThanOrEqual(160);
  expect(head.canonical).toBe(`${origin}/groups/nextjs-apps`);
  expect(head.image?.url).toBe(`${origin}/og/groups/nextjs-apps.png?v=${release.releaseId}`);
  const graph = head.structuredData?.["@graph"] as Record<string, unknown>[] | undefined;
  const dataset = graph?.[1];
  expect(dataset?.about).toEqual(
    release.group.members.map((member) => ({
      "@type": "SoftwareSourceCode",
      name: member.fullName,
      codeRepository: `https://github.com/${member.fullName}`,
    })),
  );
});

test("a group's text has one heading, its settings, and each repository's share", () => {
  const body = groupBody(release);
  expect(body.match(/<h1/g)).toHaveLength(1);
  expect(body).toContain('<h1 class="name">Next.js Apps</h1>');
  expect(body).toContain("<h2>All Settings</h2>");
  // The most accurate setting, in each repository with a share of it.
  expect(body).toContain("<h2>By Repository</h2>");
  expect(body).toContain(
    '<th scope="row">calcom/cal.com</th><td>3</td><td>100%</td><td>$1.00</td>',
  );
  expect(body).toContain('<th scope="row">dubinc/dub</th><td>2</td><td>50%</td><td>$2.25</td>');
  // No tasks were published, so it says nothing of them.
  expect(body).not.toContain("<h2>Tasks</h2>");
});

test("the home page and the sitemap list a released group", () => {
  const home = homeBody([], [release]);
  expect(home).toContain("<h2>Repository Groups</h2>");
  expect(home).toContain('<a href="/groups/nextjs-apps">Next.js Apps</a>');
  expect(sitemapOf(origin, [], [release])).toContain(
    `<url><loc>${origin}/groups/nextjs-apps</loc><lastmod>${release.releasedAt}</lastmod></url>`,
  );
});

test("a group page carries the API response the site reads, and an unknown one is not found", async () => {
  const routes = createPublicReleaseRoutes(
    { currentLines: async () => [] } as unknown as ReleaseStore,
    {
      groupReleases: {
        currentLines: async () => [release],
        releasedTasks: async () => undefined,
      } as unknown as GroupReleaseStore,
    },
  );
  const pageOf = sitePages(origin, routes);
  const page = await pageOf("/groups/nextjs-apps");
  expect(page.status).toBe(200);
  expect(page.data).toContain('data-url="/api/public/groups/nextjs-apps"');
  expect(page.data).toContain(JSON.stringify({ release }));
  expect((await pageOf("/groups/nothing-here")).status).toBe(404);
  // Not a slug at all: refused before any lookup.
  expect((await pageOf("/groups/Next.js")).status).toBe(404);
});

test("a group's link preview is drawn with its name and how many repositories it pools", () => {
  const png = cardPng(release);
  expect(png.subarray(1, 4).toString()).toBe("PNG");
});
