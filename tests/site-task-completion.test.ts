import { expect, mock, test } from "bun:test";
import type { ArtifactStore } from "../src/artifacts.js";
import { createUserStore } from "../src/auth/users.js";
import { createRepoStore } from "../src/site/repo-store.js";
import { refreshInProgress } from "../src/site/task-status.js";
import { createTaskStore } from "../src/site/task-store.js";
import { clearArchivedListingCache } from "../src/viewer/archived.js";
import { testAuthConfig, testDatabase } from "./support/site-fixture.js";

test("completed workflows persist bundles and repair incomplete accepted rows", async () => {
  const database = await testDatabase();
  try {
    const users = createUserStore(database.db, { secret: testAuthConfig.sessionSecret });
    const user = await users.upsert({
      githubId: 1,
      login: "owner",
      token: "test",
      scopes: "",
      orgs: [],
    });
    const org = (await users.orgsFor(user.id))[0];
    if (!org) throw new Error("Missing test organization");
    const repo = await createRepoStore(database.db).connect({
      orgId: org.id,
      githubId: 1,
      fullName: "owner/repo",
      defaultBranch: "main",
      private: false,
      connectedBy: user.id,
    });
    const tasks = createTaskStore(database.db);
    for (const pipelineStatus of ["in_progress", "accepted"] as const) {
      const runId = `completion-${pipelineStatus.replaceAll("_", "-")}`;
      const workflowId = `${runId}/candidate/candidate`;
      const row = await tasks.insertStarted({
        repoId: repo.id,
        runId,
        candidateId: "candidate",
        taskId: "candidate",
        difficulty: "easy",
        stage: pipelineStatus === "accepted" ? "accepted" : "verification",
        pipelineStatus,
        workflowId,
        startedBy: user.id,
      });
      if (pipelineStatus === "accepted")
        await tasks.progress(row.id, {
          round: 2,
          stage: "accepted",
          pipelineStatus,
          reason: "Persisted acceptance",
        });
      await tasks.review(row.id, { decision: "approve", note: "Preserve review", userId: user.id });
      const sibling = await tasks.insertStarted({
        repoId: repo.id,
        runId,
        candidateId: "sibling",
        taskId: "sibling",
        difficulty: "easy",
        stage: "accepted",
        pipelineStatus: "accepted",
        workflowId: `${runId}/candidate/sibling`,
        startedBy: user.id,
      });
      await tasks.upsertMany([
        {
          ...sibling,
          round: 3,
          reason: "Sibling acceptance",
          bundleKey: "existing-sibling-bundle",
        },
      ]);
      const prefix = `runs/${runId}/`;
      const bundleKey = `${prefix}authoring/candidate/round-2/attempt-1/verify-1/harbor-task.tar.gz`;
      const files = new Map([
        [
          `${prefix}authoring/candidate/round-2/definition.json`,
          JSON.stringify({ taskId: "task", difficulty: "easy", prompt: "Fix short help" }),
        ],
        [
          `${prefix}verification/candidate/round-2/result.json`,
          JSON.stringify({ kind: "accepted" }),
        ],
        [bundleKey, "bundle"],
        [`${prefix}verification/sibling/round-3/result.json`, JSON.stringify({ kind: "accepted" })],
      ]);
      let unavailable = true;
      const artifacts = {
        list: async () => {
          if (unavailable) throw new Error("Transient artifact failure");
          return [...files].map(([key, value]) => ({ key, sizeBytes: value.length }));
        },
        getByKey: async (key: string) => {
          const value = files.get(key);
          return value === undefined ? undefined : Buffer.from(value);
        },
      } as unknown as ArtifactStore;
      const snapshot = mock(async () => ({
        kind: "completed" as const,
        result: {
          progress: {
            candidateId: "candidate",
            taskId: "task",
            difficulty: "easy" as const,
            status: "accepted" as const,
            round: 2,
          },
        },
      }));
      const refresh = () =>
        refreshInProgress({
          tasks,
          artifacts,
          repo,
          status: { snapshot },
        });
      expect(await refresh()).toBe(pipelineStatus === "in_progress" ? 1 : 0);
      expect((await tasks.find(repo.id, runId, "candidate"))?.pipelineStatus).toBe("accepted");
      expect(snapshot).toHaveBeenCalledTimes(pipelineStatus === "in_progress" ? 1 : 0);
      snapshot.mockClear();
      snapshot.mockImplementation(async () => {
        throw new Error("Workflow history expired");
      });
      unavailable = false;
      clearArchivedListingCache();
      expect(await refresh()).toBe(1);
      expect(snapshot).not.toHaveBeenCalled();
      expect(await tasks.find(repo.id, runId, "candidate")).toMatchObject({
        taskId: "task",
        pipelineStatus: "accepted",
        stage: "accepted",
        round: 2,
        bundleKey,
        definition: { prompt: "Fix short help" },
        review: { decision: "approve", note: "Preserve review" },
        ...(pipelineStatus === "accepted" ? { reason: "Persisted acceptance" } : {}),
      });
      expect(await tasks.find(repo.id, runId, "sibling")).toMatchObject({
        round: 3,
        reason: "Sibling acceptance",
      });
    }
  } finally {
    clearArchivedListingCache();
    await database.close();
  }
});
