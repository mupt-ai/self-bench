import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUserStore } from "../src/auth/users.js";
import { createRepoStore } from "../src/site/repo-store.js";
import { createTaskStore } from "../src/site/task-store.js";
import { type TestDatabase, testAuthConfig, testDatabase } from "./support/site-fixture.js";

describe("postgres task store", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await testDatabase();
  });
  afterAll(async () => {
    await database.close();
  });

  test("upserts keep reviews, find matches either id, counts group by state", async () => {
    const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
    const user = await users.upsert({
      githubId: 1,
      login: "avyay",
      token: "t",
      scopes: "",
      orgs: [],
    });
    const [org] = await users.orgsFor(user.id);
    if (!org) throw new Error("org missing");
    const repos = createRepoStore(database.db);
    const repo = await repos.connect({
      orgId: org.id,
      githubId: 1,
      fullName: "avyay/x",
      defaultBranch: "main",
      private: false,
      connectedBy: user.id,
    });
    const store = createTaskStore(database.db);
    const base = {
      repoId: repo.id,
      runId: "run-a",
      stage: "accepted",
      difficulty: "hard" as const,
    };
    await store.upsertMany([
      { ...base, candidateId: "c1", taskId: "alpha", pipelineStatus: "accepted", sourcePr: 5 },
      { ...base, candidateId: "c2", taskId: "beta", pipelineStatus: "rejected", sourcePr: 9 },
    ]);
    const alpha = await store.find(repo.id, "run-a", "alpha");
    expect(alpha).toMatchObject({ candidateId: "c1", taskId: "alpha", sourcePr: 5 });
    expect((await store.find(repo.id, "run-a", "c1"))?.id).toBe(alpha?.id ?? -1);
    const reviewed = await store.review(alpha?.id ?? -1, {
      decision: "approve",
      note: "ok",
      userId: user.id,
    });
    expect(reviewed.review).toMatchObject({ decision: "approve", note: "ok", decidedBy: "avyay" });
    await store.upsertMany([
      {
        ...base,
        candidateId: "c1",
        taskId: "alpha-renamed",
        pipelineStatus: "accepted",
        sourcePr: 5,
      },
    ]);
    const renamed = await store.find(repo.id, "run-a", "alpha-renamed");
    expect(renamed?.id).toBe(alpha?.id ?? -1);
    expect(renamed?.review?.decision).toBe("approve");
    expect(await store.countsForRepos([repo.id])).toEqual([
      { repoId: repo.id, total: 2, accepted: 1, needsReview: 0, rejected: 1, lastPr: 9 },
    ]);
    expect((await store.clearReview(renamed?.id ?? -1)).review).toBeUndefined();
    expect(await store.deleteForRun(repo.id, "run-a")).toBe(2);
    expect(await store.listForRepo(repo.id)).toEqual([]);
  });
});
