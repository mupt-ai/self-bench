import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { nameLayout } from "../src/api/link-card.js";

test("the preview finds its fonts from any working directory", () => {
  // A fresh process started elsewhere, as a server can be: the fonts are found beside the module.
  const module = new URL("../src/api/link-card.ts", import.meta.url).pathname;
  const script = `
    const { cardPng } = await import(${JSON.stringify(module)});
    const png = cardPng({
      releaseId: "r", releasedAt: "2026-09-01T00:00:00Z", schemaVersion: 1,
      repository: { id: 1, fullName: "owner/name" }, publisher: { login: "someone", kind: "user" },
      tasks: 3, settings: [], frontier: [],
    });
    console.log(png.length);
  `;
  const run = Bun.spawnSync(["bun", "-e", script], { cwd: tmpdir() });
  expect(run.stderr.toString()).toBe("");
  expect(run.exitCode).toBe(0);
  expect(Number(run.stdout.toString())).toBeGreaterThan(10_000);
});

test("the preview sets a short name on one line, as large as it goes", () => {
  expect(nameLayout("vercel/next.js")).toEqual({ size: 112, lines: ["vercel/next.js"] });
});

test("the preview puts a longer name's owner over its repository", () => {
  const { size, lines } = nameLayout("kubernetes-sigs/cluster-api-provider-aws");
  expect(lines).toEqual(["kubernetes-sigs/", "cluster-api-provider-aws"]);
  expect(size).toBeGreaterThanOrEqual(72);
});

test("the preview wraps a long repository evenly under its owner", () => {
  const { size, lines } = nameLayout(
    "an-organisation-with-a-long-name/a-repository-with-an-unusually-long-name",
  );
  expect(lines).toEqual([
    "an-organisation-with-a-long-name/",
    "a-repository-with-an-",
    "unusually-long-name",
  ]);
  expect(size).toBeGreaterThanOrEqual(48);
});

test("the preview fits the longest names GitHub allows in three lines", () => {
  const owner = "o".repeat(39);
  const repo = "a-repository-name-".repeat(6).slice(0, 100);
  const { size, lines } = nameLayout(`${owner}/${repo}`);
  const room = Math.floor((1200 - 144) / (size * 0.6));
  expect(size).toBe(48);
  expect(lines).toHaveLength(3);
  expect(lines[0]).toMatch(/^…o+\/$/);
  expect(lines[2]).toMatch(/…$/);
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(room);
});

test("a group's name, which has no owner, wraps over up to three lines rather than shrinking", () => {
  expect(nameLayout("Next.js Apps")).toEqual({ size: 112, lines: ["Next.js Apps"] });
  const long = nameLayout("Full-Stack Next.js Applications Running on Vercel");
  expect(long.lines.length).toBeGreaterThan(1);
  expect(long.size).toBeGreaterThanOrEqual(56);
  const longest = nameLayout("x".repeat(80));
  expect(longest.lines.length).toBeLessThanOrEqual(3);
});
