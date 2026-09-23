import { eq } from "drizzle-orm";
import type { ArtifactStore } from "../../src/artifacts/index.js";
import { repos } from "../../src/db/schema.js";
import { createTaskStore, type TaskUpsert } from "../../src/db/tasks.js";
import type { AuthServer } from "./site-fixture.js";

const definition = (taskId: string, sourcePr: number, difficulty = "medium") => ({
  taskId,
  difficulty,
  repo: "Mupt-AI/self-bench",
  sourcePr,
  sourceUrl: `https://github.com/Mupt-AI/self-bench/pull/${sourcePr}`,
});

/** The rows the pipeline writes for the runs the site tests seed into the artifact store. */
const RUN_ROWS: Record<string, Omit<TaskUpsert, "repoId">[]> = {
  "run-one": [
    {
      runId: "run-one",
      candidateId: "c1",
      taskId: "task-good",
      sourcePr: 11,
      sourceUrl: "https://github.com/Mupt-AI/self-bench/pull/11",
      difficulty: "medium",
      pipelineStatus: "accepted",
      stage: "review",
      bundleKey: "runs/run-one/verification/c1/round-1/attempt-1/verify-1/harbor-task.tar.gz",
      definition: definition("task-good", 11),
    },
    {
      runId: "run-one",
      candidateId: "c2",
      taskId: "task-bad",
      sourcePr: 12,
      sourceUrl: "https://github.com/Mupt-AI/self-bench/pull/12",
      difficulty: "medium",
      pipelineStatus: "rejected",
      stage: "authoring",
      reason: "authoring failed: tests never fail without the solution\nmore detail",
      definition: definition("task-bad", 12),
    },
  ],
  "run-two": [
    {
      runId: "run-two",
      candidateId: "c9",
      taskId: "task-other",
      sourcePr: 13,
      sourceUrl: "https://github.com/Mupt-AI/self-bench/pull/13",
      difficulty: "medium",
      pipelineStatus: "rejected",
      stage: "authoring",
      definition: definition("task-other", 13),
    },
  ],
};

/** Seeds the task rows the pipeline would have written for one of the fixture runs. */
export async function ingestTasks(
  site: AuthServer,
  _artifacts: ArtifactStore,
  fullName: string,
  runId: string,
) {
  const [repo] = await site.db.select().from(repos).where(eq(repos.fullName, fullName));
  if (!repo) throw new Error("Test repository is not connected");
  const rows = (RUN_ROWS[runId] ?? []).map((row) => ({ ...row, repoId: repo.id }));
  await createTaskStore(site.db).upsertMany(rows);
  return { synced: rows.length };
}
