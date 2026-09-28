import { expect, test } from "bun:test";
import { repositoryPath, segmentsOf } from "../src/public/paths.js";

test("a repository path is an owner and a name, and optionally a publisher", () => {
  expect(repositoryPath(segmentsOf("/vercel/next.js"))).toEqual({
    owner: "vercel",
    name: "next.js",
  });
  expect(repositoryPath(segmentsOf("/vercel/next.js/mupt-ai/"))).toEqual({
    owner: "vercel",
    name: "next.js",
    publisher: "mupt-ai",
  });
  expect(repositoryPath(["under_score", "a.b-c_d"])).toEqual({
    owner: "under_score",
    name: "a.b-c_d",
  });
  // Segments arrive percent-encoded.
  expect(repositoryPath(["vercel", "next%2Ejs"])).toEqual({ owner: "vercel", name: "next.js" });
});

test("anything that cannot be a GitHub repository is refused", () => {
  for (const segments of [
    [],
    ["vercel"],
    ["a", "b", "c", "d"],
    ["vercel", "next js"],
    ["vercel", "next%20js"],
    ["vercel", ".."],
    ["vercel", "."],
    ["a".repeat(40), "repo"],
    ["owner", "r".repeat(101)],
    ["owner", "repo", "p".repeat(40)],
    ["owner", "repo", "<script>"],
    ["%E0%A4%A", "repo"],
  ])
    expect(repositoryPath(segments)).toBeUndefined();
  expect(repositoryPath(["a".repeat(39), "r".repeat(100), "p".repeat(39)])).toBeDefined();
});
