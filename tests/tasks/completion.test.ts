import { expect, test } from "bun:test";
import type { ArtifactStore } from "../../src/artifacts/index.js";
import type { ArtifactRef } from "../../src/contracts/index.js";
import { createRepoStore } from "../../src/db/repos.js";
import { createTaskStore } from "../../src/db/tasks.js";
import { createUserStore } from "../../src/db/users.js";
import { createTaskActivities } from "../../src/generation/tasks/activities.js";
import { testAuthConfig, testDatabase } from "../support/site-fixture.js";

const ref = (uri: string): ArtifactRef => ({
  uri,
  sha256: "a".repeat(64),
  sizeBytes: 1,
  contentType: "application/octet-stream",
});

test("a settled workflow writes its verdict and bundle onto the task row once", async () => {
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
    const runId = "completion";
    await tasks.plan([
      {
        repoId: repo.id,
        runId,
        candidateId: "candidate",
        taskId: "candidate",
        baseCommit: "a".repeat(40),
        difficulty: "easy",
        stage: "reviewing",
        workflowId: `${runId}/candidate/candidate`,
      },
    ]);
    const bundleKey = `runs/${runId}/verify/candidate/authoring-round-2/harbor-task.tar.gz`;
    const artifacts = {} as ArtifactStore;
    const result = {
      progress: {
        candidateId: "candidate",
        taskId: "task",
        difficulty: "easy" as const,
        status: "accepted" as const,
        round: 2,
      },
      task: {
        candidateId: "candidate",
        taskId: "task",
        sourceBundle: ref(
          `file:///store/runs/${runId}/authoring/candidate/round-2/source-task.tar.gz`,
        ),
        bundle: ref(`file:///store/${bundleKey}`),
      },
    };
    const workflow = createTaskActivities({ tasks, artifacts });
    await workflow.settleTask({ runId, candidateId: "candidate", result });
    const settled = await tasks.find(repo.id, runId, "candidate");
    expect(settled).toMatchObject({
      taskId: "task",
      pipelineStatus: "accepted",
      stage: "accepted",
      round: 2,
      bundleKey,
    });
    // Approvable at once, with nobody having opened it.
    await tasks.review(settled?.id ?? -1, { decision: "approve", note: "ok", userId: user.id });
    // A retried settle changes nothing.
    await workflow.settleTask({
      runId,
      candidateId: "candidate",
      result: { progress: { ...result.progress, status: "rejected", reason: "late" } },
    });
    expect(await tasks.find(repo.id, runId, "candidate")).toMatchObject({
      pipelineStatus: "accepted",
      review: { decision: "approve" },
    });
  } finally {
    await database.close();
  }
});
