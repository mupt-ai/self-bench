import { expect, test } from "bun:test";
import { groupBody, groupHead } from "../src/api/site-group.js";
import { sitemapOf } from "../src/api/site-head.js";
import { groupPath, repositoryPath, segmentsOf } from "../src/public/paths.js";
import {
  type GroupRecord,
  groupCardOf,
  groupOf,
  groupsOf,
  mostAccurate,
  pooledSettings,
  slugOf,
} from "../src/public/release-groups.js";
import {
  type PublishedLine,
  type PublishedRelease,
  RELEASE_SCHEMA_VERSION,
  type ReleaseSetting,
} from "../src/public/release-types.js";

const setting = (
  id: string,
  tasks: number,
  passed: number,
  totalCostUsd: number,
  more: Partial<ReleaseSetting> = {},
): ReleaseSetting => ({
  id,
  model: { catalogId: id, name: `openai/${id}`, label: id.toUpperCase() },
  harness: "codex",
  reasoningLevel: "high",
  provider: "openai",
  signIn: "api-key",
  custom: false,
  tasks,
  passed,
  accuracy: (passed / tasks) * 100,
  costPerTaskUsd: totalCostUsd / tasks,
  totalCostUsd,
  costedTasks: tasks,
  onFrontier: false,
  ...more,
});

const release = (
  id: number,
  fullName: string,
  settings: ReleaseSetting[],
  more: Partial<PublishedRelease> = {},
): PublishedRelease => ({
  schemaVersion: RELEASE_SCHEMA_VERSION,
  releaseId: `release-${id}`,
  releasedAt: "2026-10-01T00:00:00.000Z",
  repository: { id, fullName },
  publisher: { login: "Acme", kind: "org" },
  tasks: settings[0]?.tasks ?? 0,
  settings,
  frontier: [],
  ...more,
});

const line = (value: PublishedRelease): PublishedLine => ({ release: value, endorsed: false });

const record = (repositoryIds: number[], more: Partial<GroupRecord> = {}): GroupRecord => ({
  publisherLogin: "acme",
  slug: "web-frameworks",
  name: "Web Frameworks",
  description: "",
  repositoryIds,
  updatedAt: "2026-09-01T00:00:00.000Z",
  ...more,
});

test("pooling scores only the settings every release has, over all their tasks", () => {
  const pooled = pooledSettings([
    release(1, "a/one", [setting("sol", 10, 9, 20), setting("luna", 10, 4, 2)]),
    release(2, "b/two", [
      setting("sol", 30, 15, 90),
      // Priced on half its tasks: the pooled cost is the priced tasks' spend over their count.
      setting("luna", 30, 24, 3, { costedTasks: 15 }),
      setting("terra", 30, 30, 1),
    ]),
  ]);
  expect(pooled.map((each) => each.id)).toEqual(["sol", "luna"]);
  const [sol, luna] = pooled;
  expect(sol).toMatchObject({ tasks: 40, passed: 24, accuracy: 60, totalCostUsd: 110 });
  expect(sol?.costPerTaskUsd).toBeCloseTo(110 / 40);
  expect(luna).toMatchObject({ tasks: 40, passed: 28, accuracy: 70, costedTasks: 25 });
  expect(luna?.costPerTaskUsd).toBeCloseTo(5 / 25);
  // Luna is both cheaper and more accurate pooled, so only it is on the frontier.
  expect(pooled.map((each) => each.onFrontier)).toEqual([false, true]);
});

test("a sign-in type survives pooling only when every release used it", () => {
  const [mixed, same] = pooledSettings([
    release(1, "a/one", [setting("sol", 10, 5, 1), setting("luna", 10, 5, 1)]),
    release(2, "b/two", [
      setting("sol", 10, 5, 1, { signIn: "codex-login" }),
      setting("luna", 10, 5, 1),
    ]),
  ]);
  expect(mixed?.signIn).toBeUndefined();
  expect(same?.signIn).toBe("api-key");
});

test("a group takes each member's current release by its own publisher, in its order", () => {
  const lines = [
    line(release(1, "a/one", [setting("sol", 10, 9, 20)])),
    line(
      release(2, "b/two", [setting("sol", 20, 10, 20)], {
        releasedAt: "2026-10-05T00:00:00.000Z",
      }),
    ),
    // Another workspace's release of a member is never pooled.
    line(
      release(2, "b/two", [setting("sol", 20, 20, 20)], {
        releaseId: "other",
        publisher: { login: "someone-else", kind: "user" },
      }),
    ),
  ];
  // Member 3 has no current release, so it is left out until it is released again.
  const group = groupOf(record([2, 3, 1]), lines);
  expect(group?.members.map((member) => member.repository.fullName)).toEqual(["b/two", "a/one"]);
  expect(group).toMatchObject({ tasks: 30, slug: "web-frameworks", publisher: { login: "Acme" } });
  expect(group?.settings[0]).toMatchObject({ passed: 19, tasks: 30 });
  // Its date is the newest of the group's own save and its members' releases.
  expect(group?.updatedAt).toBe("2026-10-05T00:00:00.000Z");
  expect(group?.members[1]?.scores.sol).toMatchObject({ passed: 9, accuracy: 90 });
  expect(group && mostAccurate(group, group.members[0] ?? { scores: {} })).toEqual({
    id: "sol",
    label: "SOL",
    accuracy: 50,
  });
  expect(groupOf(record([3]), lines)).toBeUndefined();
  expect(groupsOf([record([3]), record([1], { slug: "solo" })], lines).map((g) => g.slug)).toEqual([
    "solo",
  ]);
  expect(group && groupCardOf(group)).toMatchObject({
    repositories: ["b/two", "a/one"],
    tasks: 30,
    settings: 1,
    picks: [{ roles: ["cheapest", "mostAccurate"], setting: { id: "sol" } }],
  });
});

test("group addresses are /groups/publisher/slug, and no repository is named groups", () => {
  expect(groupPath(segmentsOf("/groups/acme/web-frameworks"))).toEqual({
    publisher: "acme",
    slug: "web-frameworks",
  });
  for (const path of ["/groups/acme", "/groups/acme/Web", "/groups/acme/a--b", "/groups/a/b/c"])
    expect(groupPath(segmentsOf(path))).toBeUndefined();
  expect(repositoryPath(["groups", "acme"])).toBeUndefined();
  expect(repositoryPath(["Groups", "acme", "web"])).toBeUndefined();
  expect(slugOf("  Python Web Frameworks!  ")).toBe("python-web-frameworks");
  expect(slugOf("Ünïcode — Tools")).toBe("unicode-tools");
});

test("a group page's head, text and sitemap entry name it at its one address", () => {
  const lines = [
    line(release(1, "a/one", [setting("sol", 10, 9, 20), setting("luna", 10, 4, 2)])),
    line(release(2, "b/two", [setting("sol", 30, 15, 90), setting("luna", 30, 24, 3)])),
  ];
  const group = groupOf(record([1, 2], { description: "Two <b>frameworks</b>" }), lines);
  if (!group) throw new Error("no group");
  const head = groupHead("https://selfbench.dev", group);
  expect(head.title).toBe("Web Frameworks: Coding Agent Benchmark · SelfBench");
  expect(head.canonical).toBe("https://selfbench.dev/groups/Acme/web-frameworks");
  expect(head.description.startsWith("Which coding agent works best on Web Frameworks?")).toBe(
    true,
  );
  expect(head.description.length).toBeLessThanOrEqual(160);
  const body = groupBody(group);
  expect(body.match(/<h1>/g)).toHaveLength(1);
  expect(body).toContain("<h1>Web Frameworks</h1>");
  expect(body).toContain("Two &lt;b&gt;frameworks&lt;/b&gt;");
  for (const heading of ["Model Tradeoffs", "All Settings", "Repositories"])
    expect(body).toContain(`<h2>${heading}</h2>`);
  expect(body).toContain('href="/a/one/Acme"');
  const sitemap = sitemapOf("https://selfbench.dev", [lines], [group]);
  expect(sitemap).toContain("<loc>https://selfbench.dev/groups/Acme/web-frameworks</loc>");
});

test("a renamed workspace's group still finds releases written under its old login", () => {
  const lines = [line(release(1, "a/one", [setting("sol", 10, 9, 20)]))];
  const renamed = record([1], { publisherLogin: "acme-renamed" });
  expect(groupOf(renamed, lines)).toBeUndefined();
  expect(groupOf({ ...renamed, releaseLogins: ["Acme"] }, lines)?.members).toHaveLength(1);
});

test("a group whose members share no setting has no leaderboard headings", () => {
  const lines = [
    line(release(1, "a/one", [setting("sol", 10, 9, 20)])),
    line(release(2, "b/two", [setting("luna", 10, 9, 20)])),
  ];
  const group = groupOf(record([1, 2]), lines);
  if (!group) throw new Error("no group");
  const body = groupBody(group);
  expect(body).not.toContain("<h2>Model Tradeoffs</h2>");
  expect(body).not.toContain("<h2>All Settings</h2>");
  expect(body).toContain("No setting was released on every repository");
  expect(body).toContain("<h2>Repositories</h2>");
});
