import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/index.js";
import {
  assertHarborVersion,
  harborProcessEnvironment,
  harborPython,
  harborPythonPath,
} from "../harnesses/harbor/command.js";
import { pinnedImageKwargs } from "../harnesses/harbor/pinned-images.js";
import { assertHostSafeTask } from "../harnesses/harbor/task-safety.js";
import { runCommand } from "../lib/process.js";
import { credentialExecution } from "./execution.js";
import type { RunnerOptions } from "./runner.js";
import { unpackTrialTask } from "./task-bundle.js";
import { preparesTaskImages } from "./trial-input.js";
import type { EvaluationInput } from "./types.js";

// A cold build of a large task's two images takes minutes; Harbor gives each build this long.
const PREPARE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Builds the images of the one task in `input` with the evaluation's own sandbox credentials,
 * exactly as its trials' Harbor would (runtime/selfbench_prepare.py), so none of its trials builds
 * them, and trials of the same task never build them side by side. A task verified in this Modal
 * workspace keeps its pinned images and builds nothing. Returns what it did, one line per image.
 */
export async function prepareTaskImages(
  store: ArtifactStore,
  input: EvaluationInput,
  options: RunnerOptions = {},
): Promise<string> {
  const [task] = input.tasks;
  if (!task || input.tasks.length !== 1) throw new Error("Prepare one task at a time");
  if (!preparesTaskImages(input.sandbox)) return "";
  if (!options.vault) throw new Error("Credential storage unavailable on the worker");
  const command = options.command ?? runCommand;
  const root = await mkdtemp(join(tmpdir(), "selfbench-prepare-"));
  try {
    const home = join(root, "home");
    await mkdir(home, { mode: 0o700 });
    const execution = await credentialExecution(
      input,
      home,
      options.env ?? process.env,
      options.vault,
    );
    const child = harborProcessEnvironment(execution.child);
    const version = await command("harbor", ["--version"], { env: child, timeoutMs: 15_000 });
    assertHarborVersion(version.stdout);
    const taskPath = await unpackTrialTask(store, task, input.sandbox, root, {
      ...(options.snapshotLink ? { snapshotLink: options.snapshotLink } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    // The script reads task.toml, so it gets the same checked copy Harbor would.
    await assertHostSafeTask(taskPath, child);
    const pins = Object.entries(
      pinnedImageKwargs(input.sandbox === "modal" ? task.images : undefined),
    );
    const result = await command(
      await harborPython(child),
      [
        join(harborPythonPath(), "selfbench_prepare.py"),
        taskPath,
        input.sandbox,
        ...pins.map(([key, value]) => `${key}=${value}`),
      ],
      {
        env: child,
        timeoutMs: PREPARE_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    return result.stdout.trim();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
