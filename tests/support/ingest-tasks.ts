import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { repos } from "../../src/db/schema.js";
import { createTaskStore, type TaskUpsert } from "../../src/db/tasks.js";
import { connectRepo, signedIn } from "./sign-in.js";
import {
  type AuthServer,
  type AuthServerOptions,
  type FakeGitHubOptions,
  fakeGitHub,
  startAuthServer,
  testAuthConfig,
} from "./site-fixture.js";

const definition = (taskId: string, sourcePr: number) => ({
  taskId,
  difficulty: "medium",
  repo: "Mupt-AI/self-bench",
  testCommand: "bun test",
  failToPass: ["a"],
  passToPass: [],
  testPaths: ["tests"],
  workdir: ".",
  sourcePr,
  sourceUrl: `https://github.com/Mupt-AI/self-bench/pull/${sourcePr}`,
  baseCommit: "a".repeat(40),
});

const BUNDLE_KEY = "runs/run-one/verification/c1/round-1/attempt-1/verify-1/harbor-task.tar.gz";

/** The rows the pipeline writes for `run-one`: one accepted and one rejected candidate. */
const RUN_ONE_ROWS: Omit<TaskUpsert, "repoId">[] = [
  {
    runId: "run-one",
    candidateId: "c1",
    taskId: "task-good",
    sourcePr: 11,
    sourceUrl: "https://github.com/Mupt-AI/self-bench/pull/11",
    difficulty: "medium",
    pipelineStatus: "accepted",
    stage: "review",
    bundleKey: BUNDLE_KEY,
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
];

/** The `run-one` artifacts, as the agent pipeline writes them. */
async function seededStore(): Promise<LocalArtifactStore> {
  const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "site-tasks-")));
  const put = (key: string, value: unknown) =>
    store.put(key, Buffer.from(JSON.stringify(value)), "application/json");
  await put("runs/run-one/authoring/c1/definition.json", definition("task-good", 11));
  await put("runs/run-one/verification/c1/round-1/result.json", { kind: "accepted" });
  await store.put(BUNDLE_KEY, Buffer.from("tar"), "application/gzip");
  await put("runs/run-one/authoring/c2/definition.json", definition("task-bad", 12));
  await put("runs/run-one/authoring/c2/round-1/result.json", {
    kind: "rejected",
    reason: "authoring failed: tests never fail without the solution\nmore detail",
  });
  return store;
}

/** Seeds the `run-one` task rows the pipeline would have written into Mupt-AI/self-bench. */
async function ingestRunOne(site: AuthServer) {
  const [repo] = await site.db.select().from(repos).where(eq(repos.fullName, "Mupt-AI/self-bench"));
  if (!repo) throw new Error("Test repository is not connected");
  await createTaskStore(site.db).upsertMany(
    RUN_ONE_ROWS.map((row) => ({ ...row, repoId: repo.id })),
  );
}

/** Task routes over the `run-one` artifacts, signed in with Mupt-AI/self-bench connected. */
export async function seededTaskSite(
  options: Pick<AuthServerOptions, "start"> &
    Pick<FakeGitHubOptions, "repos" | "pullRequests"> = {},
) {
  const artifacts = await seededStore();
  const hub = fakeGitHub({
    orgs: ["Mupt-AI"],
    repos: options.repos ?? [{ full_name: "Mupt-AI/self-bench" }],
    ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
  });
  const site = await startAuthServer({
    config: testAuthConfig,
    artifacts,
    fetchImpl: hub.fetch,
    ...(options.start ? { start: options.start } : {}),
  });
  const headers = await signedIn(site);
  await connectRepo(site, headers);
  return { site, headers, artifacts, ingest: () => ingestRunOne(site) };
}
