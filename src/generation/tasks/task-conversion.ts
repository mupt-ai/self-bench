import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ArtifactStore } from "../../artifacts/index.js";
import { runCommand } from "../../lib/process.js";
import { GATE_TASK_FILE, SNAPSHOT_FILE, splitGateBundle } from "../../sandbox/gate-bundle.js";
import { unpackTask } from "../pipeline/remote-gate.js";
import { compileHarborTask } from "../task/compiler.js";
import { legacyDefinitionSchema, legacySubmission } from "../task/legacy.js";
import { shareSnapshot } from "../task/snapshot-store.js";
import { checkSubmission, SUBMISSION_FILES } from "../task/submission.js";
import { SOURCE_BUNDLE } from "./revision.js";
import {
  checkCompiledTask,
  gateSource,
  type RebuildDependencies,
  type RebuildOutcome,
} from "./task-image-rebuild.js";
import { compiledBundleKey, type ReviewedTask } from "./task-images.js";

export type ConversionOutcome =
  | RebuildOutcome
  /** The conversion cannot write this task; an author has to (revision.ts). */
  | { readonly status: "unconvertible"; readonly reason: string };

/**
 * Rewrites a task authored as definition.json into native files (legacySubmission), compiles them
 * over the task's own snapshot into `runs/<run>/conversion/<candidate>/<time>/`, and checks that
 * compile as a rebuild does: the task takes its new bundle and images only if every gate passes.
 * Each attempt writes a folder of its own, since artifacts are written once.
 */
export async function convertTask(
  store: ArtifactStore,
  task: ReviewedTask & { readonly candidateId: string },
  deps: RebuildDependencies,
): Promise<ConversionOutcome> {
  if (!task.bundleKey) return { status: "skipped", reason: "Has no bundle" };
  const { gate, snapshot } = await gateSource(
    store,
    compiledBundleKey(task.bundleKey),
    deps.signal,
  );
  const work = await mkdtemp(join(tmpdir(), "selfbench-conversion-"));
  try {
    await mkdir(join(work, "legacy"));
    const legacy = await unpackTask(store, gate, join(work, "legacy"), deps.signal);
    const read = (path: string) => readFile(join(legacy, path), "utf8");
    const definitionJson = await read("definition.json").catch(() => undefined);
    if (definitionJson === undefined) return { status: "skipped", reason: "Is not a legacy task" };
    const definition = legacyDefinitionSchema.parse(JSON.parse(definitionJson));
    const submission = legacySubmission(definition, {
      instruction: await read("instruction.md"),
      testPatch: await read("tests/test.patch"),
      goldPatch: await read("solution/gold.patch"),
    });
    if ("reason" in submission) return { status: "unconvertible", reason: submission.reason };
    const check = checkSubmission(submission, definition.difficulty);
    const problems = [...check.errors, ...check.blockers];
    if (problems.length > 0) return { status: "unconvertible", reason: problems.join("; ") };

    const repository = join(work, SNAPSHOT_FILE);
    await pipeline(await store.openRead(snapshot), createWriteStream(repository), {
      signal: deps.signal,
    });
    const output = join(work, "native");
    await mkdir(join(output, "source"), { recursive: true });
    await compileHarborTask(
      submission,
      {
        taskId: task.taskId,
        difficulty: check.difficulty,
        repo: definition.repo,
        baseCommit: definition.baseCommit,
        sourcePr: definition.sourcePr,
      },
      repository,
      join(output, "harbor-task"),
    );
    const compiled = join(output, "harbor-task.tar.gz");
    const signal = { signal: deps.signal };
    await runCommand("tar", ["-czf", compiled, "-C", output, "harbor-task"], signal);
    await splitGateBundle(compiled, output);
    const authored = SUBMISSION_FILES.filter((name) => submission[name]);
    for (const name of authored) await writeFile(join(output, "source", name), submission[name]);
    await runCommand(
      "tar",
      ["-czf", join(output, SOURCE_BUNDLE), "-C", join(output, "source"), ...authored],
      signal,
    );

    const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const directory = `runs/${task.runId}/conversion/${task.candidateId}/${stamp}`;
    const put = (name: string) =>
      store.putFile(`${directory}/${name}`, join(output, name), "application/gzip");
    for (const name of ["harbor-task.tar.gz", GATE_TASK_FILE, SNAPSHOT_FILE, SOURCE_BUNDLE])
      await put(name);
    // The snapshot is the task's own, so the shared copy usually exists already.
    await shareSnapshot(store, directory);
    return await checkCompiledTask(store, task, `${directory}/harbor-task.tar.gz`, deps);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
