import { afterAll, beforeAll, expect, test } from "bun:test";
import { createReleaseStore, currentOf, headOf } from "../src/db/releases.js";
import { RELEASE_SCHEMA_VERSION, type ReleasePayload } from "../src/public/release-types.js";
import { testDatabase } from "./support/site-fixture.js";

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});

const line = { orgId: 7, githubRepoId: 70107786 };
const payload = (fullName: string, tasks: number): ReleasePayload => ({
  schemaVersion: RELEASE_SCHEMA_VERSION,
  repository: { id: line.githubRepoId, fullName },
  publisher: { login: "acme", kind: "org" },
  tasks,
  settings: [],
  frontier: [],
});
const release = (fullName: string, tasks: number, predecessorId?: string) => ({
  line,
  fullName,
  publisherLogin: "acme",
  ...(predecessorId ? { predecessorId } : {}),
  releasedBy: { id: 1, login: "priya" },
  hash: `hash-${tasks}`,
  payload: payload(fullName, tasks),
  detail: {},
});

test("the chain, not the clock, decides the current release, in the app and in public", async () => {
  // A clock that runs backwards: the successor gets an earlier timestamp than its predecessor.
  let clock = Date.parse("2026-09-23T12:00:10Z");
  const backwards = () => {
    clock -= 10_000;
    return new Date(clock);
  };
  const store = createReleaseStore(database.db, { now: backwards });
  const first = await store.insert(release("vercel/next.js", 10));
  const second = await store.insert(release("vercel/next.js", 12, first.id));
  const rows = await store.list(line);
  expect(headOf(rows)?.id).toBe(second.id);
  expect(currentOf(rows)?.id).toBe(second.id);
  expect((await store.currentLines()).map((entry) => entry.release.releaseId)).toEqual([second.id]);
  expect(
    (await store.currentLinesFor("vercel/next.js")).map((entry) => entry.release.releaseId),
  ).toEqual([second.id]);

  // A renamed repository: found by either name, shown only under the current one.
  const third = await store.insert(release("vercel/nextjs", 12, second.id));
  expect((await store.currentLinesFor("vercel/next.js")).length).toBe(0);
  expect(
    (await store.currentLinesFor("VERCEL/nextjs")).map((entry) => entry.release.releaseId),
  ).toEqual([third.id]);

  // Withdrawing the head: the public falls back along the chain; the head stays the anchor.
  await store.withdraw(line, third.id, "marco");
  const after = await store.list(line);
  expect(headOf(after)?.id).toBe(third.id);
  expect(currentOf(after)?.id).toBe(second.id);
  expect(
    (await store.currentLinesFor("vercel/next.js")).map((entry) => entry.release.releaseId),
  ).toEqual([second.id]);
});
