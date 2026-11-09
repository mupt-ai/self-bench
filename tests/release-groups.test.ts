import { expect, test } from "bun:test";
import { groupBody, groupHead } from "../src/api/site-group.js";
import { sitemapOf } from "../src/api/sitemap.js";
import { groupPath, repositoryPath, segmentsOf } from "../src/public/paths.js";
import {
  groupCardOf,
  membersOf,
  mostAccurate,
  type PublishedGroup,
  slugOf,
} from "../src/public/release-groups.js";
import type { ReleaseSetting } from "../src/public/release-types.js";

const setting = (id: string, accuracy: number, costPerTaskUsd: number): ReleaseSetting => ({
  id,
  model: { catalogId: id, name: `openai/${id}`, label: id.toUpperCase() },
  harness: "codex",
  reasoningLevel: "high",
  provider: "openai",
  custom: false,
  tasks: 4,
  passed: (accuracy / 100) * 4,
  accuracy,
  costPerTaskUsd,
  totalCostUsd: costPerTaskUsd * 4,
  costedTasks: 4,
  onFrontier: true,
});

test("each member's share of a release is scored from the per-task results alone", () => {
  const owner = new Map([
    ["a1", 1],
    ["a2", 1],
    ["b1", 2],
    ["b2", 2],
  ]);
  const members = membersOf(
    [
      { id: 1, fullName: "a/one" },
      { id: 2, fullName: "b/two" },
    ],
    owner,
    [{ id: "sol", key: "sol-key" }],
    {
      "sol-key": {
        a1: { pass: true, costUsd: 1 },
        a2: { pass: true, costUsd: 3 },
        b1: { pass: false, costUsd: 2 },
        // Unpriced: counted as a task, not as free.
        b2: { pass: true },
      },
    },
  );
  expect(members.map((member) => member.tasks)).toEqual([2, 2]);
  expect(members[0]?.scores.sol).toMatchObject({ passed: 2, accuracy: 100, costPerTaskUsd: 2 });
  expect(members[1]?.scores.sol).toMatchObject({
    passed: 1,
    accuracy: 50,
    costPerTaskUsd: 2,
    costedTasks: 1,
  });
});

const released: PublishedGroup = {
  releaseId: "release-1",
  updatedAt: "2026-10-05T00:00:00.000Z",
  publisher: { login: "Acme", kind: "org" },
  slug: "web-frameworks",
  name: "Web Frameworks",
  description: "Two <b>frameworks</b>",
  members: [
    {
      repository: { id: 1, fullName: "a/one" },
      tasks: 2,
      scores: {
        sol: { passed: 2, tasks: 2, accuracy: 100, costPerTaskUsd: 3, costedTasks: 2 },
        luna: { passed: 2, tasks: 2, accuracy: 100, costPerTaskUsd: 1, costedTasks: 2 },
      },
    },
    {
      repository: { id: 2, fullName: "b/two" },
      tasks: 2,
      scores: {
        sol: { passed: 2, tasks: 2, accuracy: 100, costPerTaskUsd: 3, costedTasks: 2 },
        luna: { passed: 0, tasks: 2, accuracy: 0, costPerTaskUsd: 1, costedTasks: 2 },
      },
    },
  ],
  tasks: 4,
  settings: [setting("sol", 100, 3), setting("luna", 50, 1)],
  frontier: ["sol", "luna"],
};

test("a member's most accurate setting breaks a tie on what it cost there", () => {
  expect(mostAccurate(released, released.members[0] ?? { scores: {} })?.id).toBe("luna");
  expect(mostAccurate(released, released.members[1] ?? { scores: {} })?.id).toBe("sol");
  expect(groupCardOf(released)).toMatchObject({
    repositories: ["a/one", "b/two"],
    tasks: 4,
    settings: 2,
    picks: [
      { roles: ["cheapest"], setting: { id: "luna" } },
      { roles: ["mostAccurate"], setting: { id: "sol" } },
    ],
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
  const head = groupHead("https://selfbench.dev", released);
  expect(head.title).toBe("Web Frameworks: Coding Agent Benchmark · SelfBench");
  expect(head.canonical).toBe("https://selfbench.dev/groups/Acme/web-frameworks");
  expect(head.description.startsWith("Which coding agent works best on Web Frameworks?")).toBe(
    true,
  );
  expect(head.description.length).toBeLessThanOrEqual(160);
  const body = groupBody(released);
  expect(body.match(/<h1>/g)).toHaveLength(1);
  expect(body).toContain("<h1>Web Frameworks</h1>");
  expect(body).toContain("Two &lt;b&gt;frameworks&lt;/b&gt;");
  for (const heading of ["Model Tradeoffs", "All Settings", "Repositories"])
    expect(body).toContain(`<h2>${heading}</h2>`);
  expect(body).toContain('href="https://github.com/a/one"');
  const empty = groupBody({ ...released, settings: [], frontier: [] });
  expect(empty).not.toContain("<h2>All Settings</h2>");
  const sitemap = sitemapOf("https://selfbench.dev", [], [released]);
  expect(sitemap).toContain("<loc>https://selfbench.dev/groups/Acme/web-frameworks</loc>");
});

test("a reused group address shows only its newest release", async () => {
  const { snapshotOf } = await import("../src/api/public-snapshot.js");
  const older = { ...released, releaseId: "old", name: "Old" };
  const snapshot = snapshotOf([], [released, older]);
  expect(snapshot.groups.map((group) => group.releaseId)).toEqual(["release-1"]);
  expect(snapshot.group("acme", "web-frameworks")?.name).toBe("Web Frameworks");
});
