// Builds the combined accepted-task bundle from many runs: one task per source pull request, each
// compiled from its final accepted deliverable with the trusted compiler exactly as run exports are.
// usage: bun run scripts/build-combined-bundle.ts unique.json OUT_DIR NAME  (unique.json: {pr: {run, candidateId, difficulty}})

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractRegularArchive } from "../src/archive.js";
import { GcsArtifactStore } from "../src/artifacts/gcs.js";
import { authoredTaskSchema, taskDefinitionSchema } from "../src/contracts.js";
import { runCommand } from "../src/process.js";
import type { TaskCompilerServices } from "../src/temporal/activities/task-compiler.js";
import { compileSubmittedTask } from "../src/temporal/activities/task-compiler.js";

const [listPath, outDir, name, mirror] = process.argv.slice(2);
if (!listPath || !outDir || !name)
  throw new Error("usage: build-combined.ts unique.json OUT_DIR NAME");
const MIRROR = mirror;
const LANES = MIRROR ? 8 : 4;
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

const RESUME = process.env.SELFBENCH_BUNDLE_RESUME === "1";
if (!RESUME) {
  await rm(outDir, { recursive: true, force: true });
}
const bundleDir = join(outDir, name);
const tasksDir = join(bundleDir, "tasks");
const treeDir = join(outDir, `${name}-harbor-tasks`);
await mkdir(tasksDir, { recursive: true });
await mkdir(treeDir, { recursive: true });
const scratch = join(outDir, "scratch");
await mkdir(scratch, { recursive: true });
// With a local full mirror (git clone --bare), each task's repository is a shared no-checkout
// clone that takes a second; the compiler only needs cat-file, ls-tree and archive.
// The GitHub fetch authenticates the same way the default compiler does: the token stays out of
// argv and the URL and reaches git only through an askpass helper.
const askpass = join(scratch, "git-askpass.sh");
await writeFile(
  askpass,
  '#!/bin/sh\ncase "$1" in *Username*) printf x-access-token;; *) printf %s "$GH_TOKEN";; esac\n',
  { mode: 0o700 },
);
const services: TaskCompilerServices | undefined = MIRROR
  ? {
      async cloneRepository(url, commit, destination, fetchToken) {
        await runCommand("git", [
          "clone",
          "--quiet",
          "--shared",
          "--no-checkout",
          MIRROR,
          destination,
        ]);
        const present = await runCommand(
          "git",
          ["-C", destination, "cat-file", "-e", `${commit}^{commit}`],
          { allowFailure: true },
        );
        if (present.exitCode !== 0) {
          // Squash-merged PRs base on branch commits the mirror never had; fetch that one by SHA.
          const environment: NodeJS.ProcessEnv = fetchToken
            ? {
                ...process.env,
                GH_TOKEN: fetchToken,
                GIT_ASKPASS: askpass,
                GIT_TERMINAL_PROMPT: "0",
              }
            : process.env;
          await runCommand("git", ["-C", destination, "fetch", "--quiet", url, commit], {
            env: environment,
          });
        }
      },
    }
  : undefined;
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

  const existing = RESUME
    ? await readFile(join(tasksDir, `${task.taskId}.tar.gz`)).catch(() => undefined)
    : undefined;
  if (existing) {
    const sha256 = createHash("sha256").update(existing).digest("hex");
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
    const runTasks = sources[entry.run] ?? [];
    runTasks.push(task.taskId);
    sources[entry.run] = runTasks;
    console.log(`kept ${task.taskId} (already packaged)`);
    return;
  }
  const compiled = await compileSubmittedTask(
    {
      taskId: task.taskId,
      repositoryUrl: "https://github.com/PostHog/posthog.git",
      definitionBytes,
      sourceBundle: await store.get(task.sourceBundle),
      token,
    },
    services,
  );
  const expanded = join(scratch, task.taskId);
  await mkdir(expanded, { recursive: true });
  const archive = join(expanded, "harbor-task.tar.gz");
  await writeFile(archive, compiled);
  await extractRegularArchive(archive, expanded);
  // The tarball lands at its final name only once it and the tree copy are complete, so a resume
  // that finds tasks/<taskId>.tar.gz can trust it; a kill mid-write leaves only a .partial file.
  const tarPath = join(tasksDir, `${task.taskId}.tar.gz`);
  const partial = `${tarPath}.partial`;
  await runCommand("tar", ["-czf", partial, "-C", expanded, "harbor-task"]);
  await rm(join(treeDir, task.taskId), { recursive: true, force: true });
  await cp(join(expanded, "harbor-task"), join(treeDir, task.taskId), { recursive: true });
  await rename(partial, tarPath);
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
  const runTasks = sources[entry.run] ?? [];
  runTasks.push(task.taskId);
  sources[entry.run] = runTasks;
  await rm(expanded, { recursive: true, force: true });
  console.log(`packaged ${task.taskId} (${definition.difficulty}, PR ${pr}, ${entry.run})`);
}
const queue = Object.entries(unique);
await Promise.all(
  Array.from({ length: LANES }, async () => {
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
// SELFBENCH_BUNDLE_TARBALL=0 skips the single tarball: the per-task tarballs plus manifest are the
// upload unit, and the tarball would need as much disk again.
if (process.env.SELFBENCH_BUNDLE_TARBALL !== "0") {
  await runCommand("tar", ["-czf", join(outDir, `${name}.tar.gz`), "-C", outDir, name]);
}
console.log(JSON.stringify({ tasks: manifestTasks.length, byDifficulty, out: outDir }));
