import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactStore } from "../artifacts/index.js";
import { trialTimeouts } from "../contracts/agent-limit.js";
import {
  assertHarborVersion,
  HARBOR_PROCESS_TIMEOUT_MS,
  harborProcessEnvironment,
  harborPython,
  harborPythonPath,
} from "../harnesses/harbor/command.js";
import { startFromTaskImages } from "../harnesses/harbor/registry-pull.js";
import {
  assertHostSafePublishedTask,
  assertHostSafeTask,
  readTaskConfig,
} from "../harnesses/harbor/task-safety.js";
import { runCommand } from "../lib/process.js";
import { checkResources, requestedResources } from "../sandbox/resources.js";
import { credentialExecution } from "./execution.js";
import { taskImagesFailed } from "./refusal.js";
import type { RunnerOptions } from "./runner.js";
import { unpackTrialTask } from "./task-bundle.js";
import { preparesTaskImages } from "./trial-input.js";
import type { EvaluationInput } from "./types.js";

// A cold build of a large task's two images takes minutes; Harbor gives each build this long.
const PREPARE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * Builds the images of the one task in `input` with the evaluation's own sandbox credentials,
 * exactly as its trials' Harbor would (runtime/selfbench_prepare.py), so none of its trials builds
 * them, and trials of the same task never build them side by side. Returns what it did, one line
 * per image.
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
    const version = await command("harbor", ["--version"], {
      env: child,
      timeoutMs: HARBOR_PROCESS_TIMEOUT_MS.version,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    assertHarborVersion(version.stdout);
    const taskPath = await unpackTrialTask(store, task, input.sandbox, root, {
      ...(options.snapshotLink ? { snapshotLink: options.snapshotLink } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    // The script reads task.toml, so it gets the same checked copy Harbor would; a registry task
    // is only checked, since it runs exactly as published.
    if (task.registry) await assertHostSafePublishedTask(taskPath, child);
    else await assertHostSafeTask(taskPath, child, trialTimeouts(input.agentMinutes).agentSeconds);
    // A task over the account's per-sandbox limits builds nothing; its trials fail the same way.
    const fit = checkResources(
      requestedResources(await readTaskConfig(taskPath)),
      execution.sandboxLimits,
      input.sandbox,
    );
    if (fit.errors.length)
      throw taskImagesFailed(
        `This task ${fit.errors.join(", ")} (the sandbox credential's limits)`,
      );
    // An E2B template is then made from the task's exported image instead of its Dockerfile.
    const pull = await startFromTaskImages(taskPath, task.images, input.sandbox, {
      env: options.env ?? process.env,
      ...(options.snapshotLink ? { callback: options.snapshotLink } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const result = await command(
      await harborPython(child),
      [join(harborPythonPath(), "selfbench_prepare.py"), taskPath, input.sandbox],
      {
        env: { ...child, ...pull },
        timeoutMs: PREPARE_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const outcome = result.stdout.trim();
    // A template E2B could not build fails the task's trials, before any of them spends.
    const failed = outcome
      .split("\n")
      .flatMap((line) => /^(agent|verifier) failed (.*)$/.exec(line)?.slice(1) ?? []);
    if (failed.length) throw taskImagesFailed(`The ${failed[0]} image: ${failed[1]}`);
    return outcome;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
