import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRepoStore } from "../../src/db/repos.js";
import { createTaskStore } from "../../src/db/tasks.js";
import { createUserStore } from "../../src/db/users.js";
import { type TestDatabase, testAuthConfig, testDatabase } from "../support/site-fixture.js";

describe("postgres task store", () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await testDatabase();
  });
  afterAll(async () => {
    await database.close();
  });

  async function connected(githubId: number) {
    const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
    const user = await users.upsert({
      githubId,
      login: `user-${githubId}`,
      token: "t",
      scopes: "",
      orgs: [],
    });
    const [org] = await users.orgsFor(user.id);
    if (!org) throw new Error("org missing");
    const repo = await createRepoStore(database.db).connect({
      orgId: org.id,
      githubId,
      fullName: `user-${githubId}/x`,
      defaultBranch: "main",
      private: false,
      connectedBy: user.id,
    });
    return { user, repo };
  }

  const planned = (repoId: number, runId: string, candidateId: string, sourcePr: number) => ({
    repoId,
    runId,
    candidateId,
    taskId: candidateId,
    sourcePr,
    difficulty: "hard" as const,
    stage: "queued",
    workflowId: `${runId}/candidate/${candidateId}`,
  });

  test("a row moves only forward: planned, in progress, settled once", async () => {
    const { user, repo } = await connected(1);
    const store = createTaskStore(database.db);
    await store.plan([planned(repo.id, "run-a", "c1", 5), planned(repo.id, "run-a", "c2", 9)]);
    // A retried plan changes nothing.
    await store.plan([{ ...planned(repo.id, "run-a", "c1", 5), stage: "authoring" }]);
    expect((await store.find(repo.id, "run-a", "c1"))?.stage).toBe("queued");

    expect(
      await store.progress("run-a", "c1", { stage: "verifying", round: 1, taskId: "alpha" }),
    ).toBe(true);
    const alpha = await store.find(repo.id, "run-a", "alpha");
    expect(alpha).toMatchObject({ candidateId: "c1", stage: "verifying", round: 1 });
    await expect(
      store.review(alpha?.id ?? -1, { decision: "approve", note: "early", userId: user.id }),
    ).rejects.toThrow("still in progress");

    expect(
      await store.settle("run-a", "c1", {
        pipelineStatus: "accepted",
        stage: "accepted",
        bundleKey: "runs/run-a/bundle.tar.gz",
        definition: { taskId: "alpha" },
      }),
    ).toBe(true);
    // A late progress write or a second verdict from a retried activity is refused.
    expect(await store.progress("run-a", "c1", { stage: "authoring" })).toBe(false);
    expect(await store.settle("run-a", "c1", { pipelineStatus: "rejected", stage: "review" })).toBe(
      false,
    );
    const settled = await store.find(repo.id, "run-a", "c1");
    expect(settled).toMatchObject({
      pipelineStatus: "accepted",
      bundleKey: "runs/run-a/bundle.tar.gz",
    });

    const reviewed = await store.review(settled?.id ?? -1, {
      decision: "approve",
      note: "ok",
      userId: user.id,
    });
    expect(reviewed.review).toMatchObject({ decision: "approve", note: "ok", decidedBy: "user-1" });

    await store.settleRun("run-a", {
      pipelineStatus: "infrastructure_failed",
      stage: "cancelled",
      reason: "Generation cancelled.",
    });
    expect(await store.listForRun("run-a")).toMatchObject([
      { candidateId: "c1", pipelineStatus: "accepted" },
      { candidateId: "c2", pipelineStatus: "infrastructure_failed", stage: "cancelled" },
    ]);
    expect(await store.countsForRepos([repo.id])).toEqual([
      { repoId: repo.id, total: 2, accepted: 1, needsReview: 0, rejected: 1, lastPr: 9 },
    ]);
    expect((await store.clearReview(reviewed.id)).review).toBeUndefined();
  });

  test("a candidate without a row writes nothing", async () => {
    const store = createTaskStore(database.db);
    expect(await store.progress("run-none", "c1", { stage: "authoring" })).toBe(false);
    expect(
      await store.settle("run-none", "c1", { pipelineStatus: "rejected", stage: "authoring" }),
    ).toBe(false);
    expect(await store.listForRun("run-none")).toEqual([]);
  });
});
