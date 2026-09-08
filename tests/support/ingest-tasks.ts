import { eq } from "drizzle-orm";
import type { ArtifactStore } from "../../src/artifacts.js";
import { repos } from "../../src/db/schema.js";
import { createTaskStore } from "../../src/site/task-store.js";
import { syncRun } from "../../src/site/task-sync.js";
import type { AuthServer } from "./site-fixture.js";

/** Seed the isolated site database through the same ingestion used by workflow completion. */
export async function ingestTasks(
  site: AuthServer,
  artifacts: ArtifactStore,
  fullName: string,
  runId: string,
) {
  const [repo] = await site.db.select().from(repos).where(eq(repos.fullName, fullName));
  if (!repo) throw new Error("Test repository is not connected");
  return syncRun({ tasks: createTaskStore(site.db), artifacts, repo, runId });
}
