import { expect, test } from "bun:test";
import { headTags, repositoryHead, sitemapOf } from "../src/api/site-head.js";
import type { PublishedLine, ReleaseSetting } from "../src/public/release-types.js";
import { defaultLineOf, repositoryDescription } from "../src/public/seo.js";

const setting = (
  label: string,
  accuracy: number,
  costPerTaskUsd: number,
  onFrontier = true,
  more: Partial<ReleaseSetting> = {},
) =>
  ({
    id: `${label}|${more.reasoningLevel ?? "high"}`,
    model: { label },
    harness: "codex",
    reasoningLevel: "high",
    accuracy,
    costPerTaskUsd,
    onFrontier,
    ...more,
  }) as ReleaseSetting;

const line = (
  publisher: string,
  releasedAt: string,
  settings: ReleaseSetting[],
  endorsed = false,
): PublishedLine =>
  ({
    release: {
      releaseId: `${publisher}@${releasedAt}`,
      releasedAt,
      repository: { fullName: "earendil-works/pi" },
      publisher: { login: publisher },
      tasks: 47,
      settings,
    },
    endorsed,
  }) as unknown as PublishedLine;

const origin = "https://selfbench.dev";

const described = (settings: ReleaseSetting[]) =>
  repositoryDescription(line("mupt-ai", "2026-09-01T00:00:00Z", settings));

test("a repository's description names its most accurate setting and the best one for less", () => {
  expect(
    described([
      setting("Claude Opus 5.5", 72.34, 1.5),
      setting("GPT-5.5 Mini", 51, 0.042),
      setting("Off Frontier", 40, 2, false),
    ]),
  ).toBe(
    "Which coding agent works best on earendil-works/pi? Most accurate: Claude Opus 5.5, 72.3% at $1.50 per task. Best for less: GPT-5.5 Mini, 51% at $0.042.",
  );
  // The next setting on the frontier, not the cheapest one.
  expect(
    described([setting("Top", 90, 2), setting("Middle", 85, 0.5), setting("Cheap", 30, 0.001)]),
  ).toContain("Most accurate: Top, 90% at $2.00 per task. Best for less: Middle, 85% at $0.50.");
  // Two settings of one model are told apart by what differs, as on the site.
  expect(
    described([
      setting("GPT-6 Sol", 90, 1),
      setting("GPT-6 Sol", 85, 0.3, true, { reasoningLevel: "medium" }),
    ]),
  ).toContain(
    "Most accurate: GPT-6 Sol (High), 90% at $1.00 per task. Best for less: GPT-6 Sol (Medium), 85% at $0.30.",
  );
  // A frontier of one names it once.
  expect(described([setting("Solo", 80, 1)])).toBe(
    "Which coding agent works best on earendil-works/pi? Most accurate: Solo, 80% at $1.00 per task.",
  );
});

test("a description fits a search result: whole sentences, in order, within 160 characters", () => {
  const settings = [setting("Claude Opus 5.5", 72.34, 1.5), setting("GPT-5.5 Mini", 51, 0.042)];
  const full = repositoryDescription(line("mupt-ai", "2026-09-01T00:00:00Z", settings), Infinity);
  expect(full).toEndWith("2 model settings scored on 47 tasks from its merged pull requests.");
  expect(described(settings).length).toBeLessThanOrEqual(160);
  // Long names leave out the best for less, and never cut a sentence.
  const long = described([
    setting("A Very Long Custom Model Label With Many Words", 90, 1),
    setting("Another Very Long Custom Model Label Too", 80, 0.5),
  ]);
  expect(long).toEndWith("90% at $1.00 per task.");
  expect(long.length).toBeLessThanOrEqual(160);
  // The question always leads, even when a repository's name alone fills the space.
  const named = {
    ...line("mupt-ai", "2026-09-01T00:00:00Z", settings),
  } as PublishedLine;
  const longName = `${"o".repeat(39)}/${"n".repeat(100)}`;
  const huge = repositoryDescription({
    ...named,
    release: { ...named.release, repository: { ...named.release.repository, fullName: longName } },
  });
  expect(huge).toBe(`Which coding agent works best on ${longName}?`);
});

test("the default line is the endorsed one, else the newest", () => {
  const older = line("older", "2026-08-01T00:00:00Z", []);
  const newer = line("newer", "2026-09-01T00:00:00Z", []);
  expect(defaultLineOf([older, newer])).toBe(newer);
  const endorsed = line("endorsed", "2026-07-01T00:00:00Z", [], true);
  expect(defaultLineOf([older, newer, endorsed])).toBe(endorsed);
  expect(defaultLineOf([])).toBeUndefined();
});

test("a head's text cannot break out of its tags", () => {
  const tags = headTags(
    {
      title: 'A "quoted" <title>',
      description: "Fish & chips",
      structuredData: { name: "</script><script>alert(1)</script>" },
    },
    origin,
  );
  expect(tags).toContain("<title>A &quot;quoted&quot; &lt;title></title>");
  expect(tags).toContain('content="Fish &amp; chips"');
  expect(tags).not.toContain("</script><script>");
  expect(tags).not.toContain("canonical");
});

test("the sitemap dates each page by its newest release and skips repositories with none", () => {
  const acme = line("acme", "2026-09-02T00:00:00Z", []);
  const beta = line("beta", "2026-09-05T00:00:00Z", []);
  const sitemap = sitemapOf(origin, [[acme, beta], []]);
  expect(sitemap).toStartWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset');
  expect(sitemap).toContain(
    "<url><loc>https://selfbench.dev/</loc><lastmod>2026-09-05T00:00:00Z</lastmod></url>",
  );
  expect(sitemap).toContain(
    "<url><loc>https://selfbench.dev/earendil-works/pi</loc><lastmod>2026-09-05T00:00:00Z</lastmod></url>",
  );
  expect(sitemap).toContain(
    "<url><loc>https://selfbench.dev/earendil-works/pi/acme</loc><lastmod>2026-09-02T00:00:00Z</lastmod></url>",
  );
  expect(sitemap).not.toContain("/earendil-works/pi/beta");
  expect(sitemapOf(origin, [])).toContain("<url><loc>https://selfbench.dev/</loc></url>");
});

test("a publisher with no line has no page", () => {
  expect(
    repositoryHead(origin, [line("acme", "2026-09-02T00:00:00Z", [])], "nobody"),
  ).toBeUndefined();
  expect(repositoryHead(origin, [])).toBeUndefined();
});

test("a repository's head points link previews at its release's card; others keep the icon", () => {
  const lines = [
    line("mupt-ai", "2026-09-02T00:00:00Z", [setting("Solo", 80, 1)]),
    line("acme", "2026-09-01T00:00:00Z", [setting("Solo", 70, 1)]),
  ];
  const head = repositoryHead(origin, lines);
  expect(head?.image?.url).toBe(
    `${origin}/og/earendil-works/pi.png?v=mupt-ai%402026-09-02T00%3A00%3A00Z`,
  );
  expect(repositoryHead(origin, lines, "ACME")?.image?.url).toStartWith(
    `${origin}/og/earendil-works/pi/acme.png?v=`,
  );
  const tags = headTags(head ?? { title: "", description: "" }, origin);
  expect(tags).toContain('<meta property="og:image:width" content="1200" />');
  expect(tags).toContain('<meta name="twitter:card" content="summary_large_image" />');
  expect(tags).not.toContain("icon-192.png");

  const plain = headTags({ title: "SelfBench", description: "Home" }, origin);
  expect(plain).toContain(`<meta property="og:image" content="${origin}/icon-192.png" />`);
  expect(plain).toContain('<meta name="twitter:card" content="summary" />');
});

test("a repository page describes its place in the site and its results as a dataset", () => {
  const settings = [setting("Claude Opus 5.5", 72.34, 1.5), setting("GPT-5.5 Mini", 51, 0.042)];
  const lines = [
    line("mupt-ai", "2026-09-02T00:00:00Z", settings),
    line("acme", "2026-09-01T00:00:00Z", settings),
  ];
  const graph = (publisher?: string) =>
    (repositoryHead(origin, lines, publisher)?.structuredData?.["@graph"] ?? []) as Record<
      string,
      unknown
    >[];
  const [crumbs, dataset] = graph();
  expect(crumbs?.["@type"]).toBe("BreadcrumbList");
  expect(crumbs?.itemListElement).toEqual([
    { "@type": "ListItem", position: 1, name: "SelfBench", item: "https://selfbench.dev/" },
    {
      "@type": "ListItem",
      position: 2,
      name: "earendil-works/pi",
      item: "https://selfbench.dev/earendil-works/pi",
    },
  ]);
  expect(dataset).toMatchObject({
    "@type": "Dataset",
    name: "earendil-works/pi coding agent benchmark results",
    url: "https://selfbench.dev/earendil-works/pi",
    datePublished: "2026-09-02T00:00:00Z",
    distribution: { contentUrl: "https://selfbench.dev/api/public/repos/earendil-works/pi" },
  });
  // The whole summary, which search results would cut short.
  expect(dataset?.description).toEndWith("from its merged pull requests.");
  // Another publisher's line is a page of its own, one level further down.
  const [ownCrumbs, ownDataset] = graph("acme");
  expect((ownCrumbs?.itemListElement as unknown[] | undefined)?.at(-1)).toMatchObject({
    position: 3,
    name: "Run by acme",
    item: "https://selfbench.dev/earendil-works/pi/acme",
  });
  expect(ownDataset?.name).toBe("earendil-works/pi coding agent benchmark results run by acme");
});
