import { expect, test } from "bun:test";
import { homeBody, notFoundBody, repositoryBody } from "../src/api/site-body.js";
import type { PublishedLine, ReleaseSetting } from "../src/public/release-types.js";
import { HOME_HEADING } from "../src/public/seo.js";

const setting = (id: string, label: string, accuracy: number, costPerTaskUsd: number) =>
  ({
    id,
    model: { catalogId: id, name: `openai/${id}`, label },
    harness: "codex",
    reasoningLevel: "high",
    provider: "openai",
    signIn: "api-key",
    custom: false,
    tasks: 10,
    passed: accuracy / 10,
    accuracy,
    costPerTaskUsd,
    totalCostUsd: costPerTaskUsd * 10,
    onFrontier: accuracy > 60,
  }) as ReleaseSetting;

const line = (
  fullName: string,
  publisher: string,
  releasedAt: string,
  settings: ReleaseSetting[],
): PublishedLine => ({
  release: {
    schemaVersion: 1,
    releaseId: `${fullName}/${publisher}@${releasedAt}`,
    releasedAt,
    repository: {
      id: fullName.length,
      fullName,
      description: "The React Framework :rocket:",
      language: "TypeScript",
      defaultBranch: "main",
      stars: 10,
      pushedAt: "2026-09-01T00:00:00Z",
      ownerAvatarUrl: "https://github.com/owner.png",
    },
    publisher: { login: publisher, kind: "org" },
    tasks: 13,
    settings,
    frontier: settings.filter((each) => each.onFrontier).map((each) => each.id),
  },
  endorsed: false,
});

const settings = [
  setting("sol", "GPT-6 Sol", 92.3, 2.87),
  setting("luna", "GPT-6 Luna", 69.2, 0.36),
  setting("weak", "Weak <Model>", 40, 5),
];
const acme = line("vercel/next.js", "acme", "2026-09-02T00:00:00Z", settings);
const marco = line("vercel/next.js", "marco", "2026-09-01T00:00:00Z", settings.slice(0, 1));

const count = (html: string, tag: string) => html.split(`<${tag}`).length - 1;

test("the home page's text has its heading and a link to each repository", () => {
  const html = homeBody([[acme, marco]]);
  expect(count(html, "h1")).toBe(1);
  expect(html).toContain(`<h1>${HOME_HEADING}</h1>`);
  // One entry per repository, at its default line.
  expect(count(html, "li")).toBe(1);
  expect(html).toContain('<a href="/vercel/next.js">vercel/next.js</a>');
  expect(html).toContain("13 tasks, 3 settings, run by acme.");
  expect(homeBody([])).not.toContain("<ul>");
});

test("a repository page's text names it and lists every setting", () => {
  const html = repositoryBody([acme, marco]) ?? "";
  expect(count(html, "h1")).toBe(1);
  expect(html).toContain("vercel/<wbr />next.js</h1>");
  // One row per setting, most accurate first, under the page's own column names.
  expect(count(html.split("<tbody>")[1]?.split("</tbody>")[0] ?? "", "tr")).toBe(3);
  expect(html.indexOf("GPT-6 Sol")).toBeLessThan(html.indexOf("GPT-6 Luna"));
  expect(html).toContain('<th scope="col">Cost / Task</th>');
  // The GitHub description without emoji shortcodes, and the other publisher's line.
  expect(html).toContain("<p>The React Framework</p>");
  expect(html).toContain('<a href="/vercel/next.js/marco">marco</a>');
});

test("a publisher's line links back to the repository's default line", () => {
  const html = repositoryBody([acme, marco], "MARCO") ?? "";
  expect(html).toContain("Run by marco");
  expect(html).toContain('<a href="/vercel/next.js">acme</a>');
  expect(repositoryBody([acme], "nobody")).toBeUndefined();
});

test("text from a release cannot break out of the page", () => {
  const html = repositoryBody([acme]) ?? "";
  expect(html).toContain("Weak &lt;Model&gt;");
  expect(html).not.toContain("Weak <Model>");
});

test("a page that is not found still has one heading", () => {
  expect(count(notFoundBody("nobody/nothing"), "h1")).toBe(1);
  expect(notFoundBody()).toContain("<h1>Page Not Found</h1>");
});
