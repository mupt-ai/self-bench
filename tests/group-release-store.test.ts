import { afterAll, beforeAll, expect, test } from "bun:test";
import type { NewGroupRelease } from "../src/db/group-releases.js";
import { createGroupReleaseStore, SlugTaken } from "../src/db/group-releases.js";
import { currentOf, ReleaseConflict } from "../src/db/releases.js";
import { RELEASE_SCHEMA_VERSION } from "../src/public/release-types.js";
import { testDatabase } from "./support/site-fixture.js";

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
});
afterAll(async () => {
  await database.close();
});

const lineOf = (orgId: number) => ({ orgId, groupId: crypto.randomUUID() });
const release = (
  line: ReturnType<typeof lineOf>,
  slug: string,
  tasks: number,
  predecessorId?: string,
): NewGroupRelease => ({
  line,
  slug,
  name: "Next.js Apps",
  publisherLogin: "acme",
  ...(predecessorId ? { predecessorId } : {}),
  releasedBy: { id: 1, login: "priya" },
  hash: `hash-${tasks}`,
  payload: {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    group: { slug, name: "Next.js Apps", members: [] },
    publisher: { login: "acme", kind: "org" as const },
    tasks,
    settings: [],
    frontier: [],
    breakdown: [],
  },
  detail: { releasedTasks: [{ key: "k", repository: "calcom/cal.com" }] },
});

test("a group line chains its releases and falls back when one is withdrawn", async () => {
  const store = createGroupReleaseStore(database.db);
  const line = lineOf(7);
  const first = await store.insert(release(line, "nextjs-apps", 10));
  const second = await store.insert(release(line, "nextjs-apps", 12, first.id));
  // A second release built on the same head loses.
  await expect(store.insert(release(line, "nextjs-apps", 13, first.id))).rejects.toThrow(
    ReleaseConflict,
  );
  expect(currentOf(await store.list(line))?.id).toBe(second.id);
  expect((await store.currentLines()).map((entry) => entry.releaseId)).toContain(second.id);
  await store.withdraw(line, second.id, "priya");
  expect(currentOf(await store.list(line))?.id).toBe(first.id);
  expect(await store.releasedTasks(first.id)).toMatchObject([
    { key: "k", repository: "calcom/cal.com" },
  ]);
});

test("a slug belongs to the first line that released under it, withdrawn or not", async () => {
  const store = createGroupReleaseStore(database.db);
  const [mine, theirs] = [lineOf(8), lineOf(9)];
  const first = await store.insert(release(mine, "web-apps", 5));
  await store.withdraw(mine, first.id, "priya");
  expect(await store.slugTaken("WEB-APPS", theirs)).toBe(true);
  expect(await store.slugTaken("web-apps", mine)).toBe(false);
  await expect(store.insert(release(theirs, "Web-Apps", 5))).rejects.toThrow(SlugTaken);
});
