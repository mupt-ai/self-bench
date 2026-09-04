// Builds the combined accepted-task bundle from many runs: one task per source pull request, each
// compiled from its final accepted deliverable with the trusted compiler exactly as run exports are.
// usage: bun run scripts/build-combined-bundle.ts unique.json OUT_DIR NAME  (unique.json: {pr: {run, candidateId, difficulty}})

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractRegularArchive } from "../src/archive.js";
import { GcsArtifactStore } from "../src/artifacts/gcs.js";
import { authoredTaskSchema, taskDefinitionSchema } from "../src/contracts.js";
import { runCommand } from "../src/process.js";
import { compileSubmittedTask } from "../src/temporal/activities/task-compiler.js";

const [listPath, outDir, name] = process.argv.slice(2);
if (!listPath || !outDir || !name)
  throw new Error("usage: build-combined.ts unique.json OUT_DIR NAME");
const token = execSync("gh auth token", { encoding: "utf8" }).trim();
const store = new GcsArtifactStore("dari-agent-host-prod-selfbench-artifacts", "selfbench/posthog");
const unique = JSON.parse(await readFile(listPath, "utf8")) as Record<
  string,
  { difficulty: string; run: string; candidateId: string }
>;

async function readJson(key: string): Promise<unknown | undefined> {
  const bytes = await store.getByKey(key);
  return bytes ? JSON.parse(Buffer.from(bytes).toString("utf8")) : undefined;
}
async function finalTask(run: string, candidateId: string) {
  let task: unknown;
  for (let round = 1; round <= 3; round += 1) {
    const r = (await readJson(
      `runs/${run}/verification/${candidateId}/round-${round}/result.json`,
    )) as { kind?: string; task?: unknown } | undefined;
    if (r?.kind === "fixed" && r.task) task = r.task;
  }
  if (!task) {
    for (let round = 1; round <= 3; round += 1) {
      const r = (await readJson(
        `runs/${run}/authoring/${candidateId}/round-${round}/result.json`,
      )) as { kind?: string; task?: unknown } | undefined;
      if (r?.kind === "submitted" && r.task) task = r.task;
    }
  }
  if (!task) throw new Error(`no final task for ${run}/${candidateId}`);
  return authoredTaskSchema.omit({ bundle: true }).parse(task);
}

await rm(outDir, { recursive: true, force: true });
const bundleDir = join(outDir, name);
const tasksDir = join(bundleDir, "tasks");
const treeDir = join(outDir, `${name}-harbor-tasks`);
await mkdir(tasksDir, { recursive: true });
await mkdir(treeDir, { recursive: true });
const scratch = join(outDir, "scratch");
const manifestTasks: Record<string, unknown>[] = [];
const byDifficulty: Record<string, number> = {};
const sources: Record<string, string[]> = {};
async function packageOne([pr, entry]: [
  string,
  { difficulty: string; run: string; candidateId: string },
]) {
  const task = await finalTask(entry.run, entry.candidateId);
  const definitionBytes = await store.get(task.definition);
  const definition = taskDefinitionSchema.parse(
    JSON.parse(Buffer.from(definitionBytes).toString("utf8")),
  );
  const compiled = await compileSubmittedTask({
    taskId: task.taskId,
    repositoryUrl: "https://github.com/PostHog/posthog.git",
    definitionBytes,
    sourceBundle: await store.get(task.sourceBundle),
    token,
  });
  const expanded = join(scratch, task.taskId);
  await mkdir(expanded, { recursive: true });
  const archive = join(expanded, "harbor-task.tar.gz");
  await writeFile(archive, compiled);
  await extractRegularArchive(archive, expanded);
  const tarPath = join(tasksDir, `${task.taskId}.tar.gz`);
  await runCommand("tar", ["-czf", tarPath, "-C", expanded, "harbor-task"]);
  await cp(join(expanded, "harbor-task"), join(treeDir, task.taskId), { recursive: true });
  const sha256 = createHash("sha256")
    .update(await readFile(tarPath))
    .digest("hex");
  manifestTasks.push({
    taskId: task.taskId,
    sha256,
    sourcePr: definition.sourcePr,
    difficulty: definition.difficulty,
    run: entry.run,
    candidateId: entry.candidateId,
    baseCommit: (definition as { baseCommit?: string }).baseCommit,
  });
  byDifficulty[definition.difficulty] = (byDifficulty[definition.difficulty] ?? 0) + 1;
  (sources[entry.run] ??= []).push(task.taskId);
  await rm(expanded, { recursive: true, force: true });
  console.log(`packaged ${task.taskId} (${definition.difficulty}, PR ${pr}, ${entry.run})`);
}
const queue = Object.entries(unique);
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      await packageOne(next);
    }
  }),
);
await rm(scratch, { recursive: true, force: true });
const manifest = {
  schemaVersion: 1,
  name,
  repository: { url: "https://github.com/PostHog/posthog.git", commit: "mixed" },
  acceptedCount: manifestTasks.length,
  byDifficulty,
  tasks: manifestTasks,
  sources: Object.entries(sources).map(([runId, taskIds]) => ({ runId, taskIds })),
  notes:
    "One accepted task per source pull request, taken from each candidate's final accepted deliverable (the last verifier fix, else the authoring submission), packaged with the trusted compiler exactly as run exports are.",
};
await writeFile(join(bundleDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(
  join(bundleDir, "README.md"),
  `# PostHog SelfBench combined accepted eval (${manifestTasks.length} tasks)

${manifestTasks.length} unique accepted Harbor tasks from the SelfBench agent pipeline (discovery agent, authoring agent with in-session harness verification, independent verification agent), one per source pull request.

Difficulty mix: ${Object.entries(byDifficulty)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ")}.

Each \`tasks/<taskId>.tar.gz\` expands to \`harbor-task/\` with task.toml, instruction.md, environment/, tests/, and solution/. \`manifest.json\` lists every task with its SHA-256, source PR, difficulty, base commit, and the run and candidate it came from. Base commits vary per task, so \`repository.commit\` is \`mixed\`.
`,
);
await runCommand("tar", ["-czf", join(outDir, `${name}.tar.gz`), "-C", outDir, name]);
console.log(JSON.stringify({ tasks: manifestTasks.length, byDifficulty, out: outDir }));
