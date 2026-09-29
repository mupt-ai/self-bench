import { expect, test } from "bun:test";
import { headTags, repositoryHead, sitemapOf } from "../src/api/site-head.js";
import type { PublishedLine, ReleaseSetting } from "../src/public/release-types.js";
import { defaultLineOf, repositoryDescription } from "../src/public/seo.js";

const setting = (label: string, accuracy: number, costPerTaskUsd: number, onFrontier = true) =>
  ({ id: label, model: { label }, accuracy, costPerTaskUsd, onFrontier }) as ReleaseSetting;

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

test("a repository's description names what was measured and the settings its cards pick", () => {
  const settings = [
    setting("Claude Opus 5.5", 72.34, 1.5),
    setting("GPT-5.5 Mini", 51, 0.042),
    setting("Off Frontier", 40, 2, false),
  ];
  expect(repositoryDescription(line("mupt-ai", "2026-09-01T00:00:00Z", settings))).toBe(
    "Which coding agent works best on earendil-works/pi? 3 model settings scored on 47 tasks from its own merged pull requests. Most accurate: Claude Opus 5.5, 72.3%. Cheapest on the frontier: GPT-5.5 Mini, $0.042 per task.",
  );
  // One setting that is both picks is named once.
  expect(
    repositoryDescription(line("mupt-ai", "2026-09-01T00:00:00Z", [setting("Solo", 80, 1)])),
  ).toBe(
    "Which coding agent works best on earendil-works/pi? 1 model setting scored on 47 tasks from its own merged pull requests. Most accurate: Solo, 80%.",
  );
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
