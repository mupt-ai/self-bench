import { expect, test } from "bun:test";
import { memorySource } from "./source";
import { page } from "./test-fixture";

const acme = page({ releaseId: "acme-2", releasedAt: "2026-09-16T00:00:00Z" });
const lena = page(
  {
    releaseId: "lena-1",
    releasedAt: "2026-09-10T00:00:00Z",
    publisher: { login: "lena-oss", kind: "user" },
  },
  false,
);
const vite = page({
  releaseId: "vite-1",
  releasedAt: "2026-09-12T00:00:00Z",
  repository: { id: 257485422, fullName: "vitejs/vite" },
});
const source = memorySource([lena, vite, acme]);

test("the directory lists one card per repository, newest release first", async () => {
  const cards = await source.listRepos();
  expect(cards.map((card) => [card.repository.fullName, card.publisher.login])).toEqual([
    ["vercel/next.js", "acme-labs"],
    ["vitejs/vite", "acme-labs"],
  ]);
  expect(cards[0]?.picks.map((pick) => pick.setting.id)).toEqual(["qwen", "sol"]);
  expect(cards[0]?.frontier.map((entry) => entry.id)).toEqual(["qwen", "sonnet", "sol"]);
});

test("a repository page shows the newest line and lists every line", async () => {
  const found = await source.getRepo("Vercel", "Next.js");
  expect(found?.release.releaseId).toBe("acme-2");
  expect(found?.lines.map((line) => line.publisher.login)).toEqual(["acme-labs", "lena-oss"]);
});

test("an endorsed line is the default for the page and the directory alike, even when older", async () => {
  const endorsed = memorySource([acme, { ...lena, endorsed: true }, vite]);
  expect((await endorsed.getRepo("vercel", "next.js"))?.release.releaseId).toBe("lena-1");
  const cards = await endorsed.listRepos();
  const nextCard = cards.find((card) => card.repository.fullName === "vercel/next.js");
  expect(nextCard?.releaseId).toBe("lena-1");
  expect(nextCard?.publisher.login).toBe("lena-oss");
  expect(nextCard?.endorsed).toBe(true);
  // Cards are ordered by the release date of the line each one shows.
  expect(cards.map((card) => card.releaseId)).toEqual(["vite-1", "lena-1"]);
});

test("a publisher's line resolves by login and unknown names return nothing", async () => {
  expect((await source.getLine("vercel", "next.js", "LENA-OSS"))?.release.releaseId).toBe("lena-1");
  expect(await source.getLine("vercel", "next.js", "nobody")).toBeUndefined();
  expect(await source.getRepo("django", "django")).toBeUndefined();
});
