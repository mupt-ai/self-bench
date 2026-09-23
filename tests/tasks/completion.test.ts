import { expect, mock, test } from "bun:test";
import type { ArtifactStore } from "../../src/artifacts/index.js";
import type { ArtifactRef } from "../../src/contracts/index.js";
import { createRepoStore } from "../../src/db/repos.js";
import { createTaskStore } from "../../src/db/tasks.js";
import { createUserStore } from "../../src/db/users.js";
import { refreshInProgress } from "../../src/generation/tasks/status.js";
import { testAuthConfig, testDatabase } from "../support/site-fixture.js";

const ref = (uri: string): ArtifactRef => ({
  uri,
  sha256: "a".repeat(64),
  sizeBytes: 1,
  contentType: "application/octet-stream",
});

test("a completed workflow writes its verdict, bundle, and definition onto the task row", async () => {
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
    const row = await tasks.insertStarted({
      repoId: repo.id,
      runId,
      candidateId: "candidate",
      taskId: "candidate",
      difficulty: "easy",
      stage: "review",
      pipelineStatus: "in_progress",
      workflowId: `${runId}/candidate/candidate`,
      startedBy: user.id,
    });
    await tasks.review(row.id, { decision: "approve", note: "Preserve review", userId: user.id });
    const bundleKey = `runs/${runId}/verify/candidate/authoring-round-2/harbor-task.tar.gz`;
    const artifacts = {
      get: async () => Buffer.from(JSON.stringify({ taskId: "task", prompt: "Fix short help" })),
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
        task: {
          candidateId: "candidate",
          taskId: "task",
          definition: ref(
            `file:///store/runs/${runId}/authoring/candidate/round-2/definition.json`,
          ),
          sourceBundle: ref(
            `file:///store/runs/${runId}/authoring/candidate/round-2/source-task.tar.gz`,
          ),
          bundle: ref(`file:///store/${bundleKey}`),
        },
      },
    }));
    expect(await refreshInProgress({ tasks, artifacts, repo, status: { snapshot } })).toBe(1);
    expect(await tasks.find(repo.id, runId, "candidate")).toMatchObject({
      taskId: "task",
      pipelineStatus: "accepted",
      stage: "accepted",
      round: 2,
      bundleKey,
      definition: { prompt: "Fix short help" },
      review: { decision: "approve", note: "Preserve review" },
    });
    // Settled rows are not polled again.
    snapshot.mockClear();
    expect(await refreshInProgress({ tasks, artifacts, repo, status: { snapshot } })).toBe(0);
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    await database.close();
  }
});
