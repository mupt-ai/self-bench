import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancelledFailure } from "@temporalio/workflow";
import { LocalArtifactStore } from "../src/artifacts/index.js";
import { prepareTaskImages } from "../src/evaluation/prepare.js";
import { trialInput } from "../src/evaluation/trial-input.js";
import type { EvaluationInput } from "../src/evaluation/types.js";
import { taskImagesReady } from "../src/evaluation/workflow.js";
import { HARBOR_VERSION, harborPythonPath } from "../src/harnesses/harbor/command.js";
import { runCommand } from "../src/lib/process.js";
import { credentialedInput, evaluationInput } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "evaluation-prepare-"));
  directories.push(directory);
  return directory;
}

/** Two tasks, two harnesses each: trials 0 and 1 run task one, trials 2 and 3 task two. */
function twoTasks(sandbox: EvaluationInput["sandbox"]): EvaluationInput {
  const input = evaluationInput();
  input.sandbox = sandbox;
  input.harnesses = ["codex", "pi"];
  input.tasks.push({ runId: "run-one", taskId: "task-two", bundleKey: "tasks/two.tar.gz" });
  return input;
}

test("each task's images are built once, before any of its trials, and a failed build is not fatal", async () => {
  const input = twoTasks("modal");
  const builds: string[] = [];
  let finish = () => {};
  const firstBuild = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const ready = taskImagesReady(input, {
    prepareTaskImages: async (single) => {
      builds.push(single.tasks.map((task) => task.taskId).join());
      if (builds.length === 1) await firstBuild;
      else throw new Error("Modal is unavailable");
      return "";
    },
  });

  let started = false;
  const trials = [ready(0), ready(1)].map((wait) => wait.then(() => (started = true)));
  await Promise.resolve();
  expect(started).toBe(false);
  finish();
  await Promise.all(trials);
  await Promise.all([ready(2), ready(3)]);

  expect(builds).toEqual(["task-one", "task-two"]);
});

test("a cancelled build stops the task's trials, and backends without a shared image cache skip it", async () => {
  const cancelled = taskImagesReady(twoTasks("e2b"), {
    prepareTaskImages: async () => {
      throw new CancelledFailure("evaluation cancelled");
    },
  });
  await expect(cancelled(0)).rejects.toBeInstanceOf(CancelledFailure);

  const docker = taskImagesReady(twoTasks("docker"), {
    prepareTaskImages: async () => {
      throw new Error("never built");
    },
  });
  await docker(0);
});

test("the build runs on Harbor's own Python with the evaluation's sandbox and the task's pins", async () => {
  const root = await temporary();
  const bin = join(root, "bin");
  await mkdir(bin);
  // Harbor's launcher names its interpreter in its shebang, as a uv tool install does.
  await writeFile(join(bin, "harbor"), "#!/opt/uv-tools/harbor/bin/python\n");
  await chmod(join(bin, "harbor"), 0o755);
  const task = join(root, "task", "harbor-task");
  await mkdir(task, { recursive: true });
  await writeFile(join(task, "task.toml"), 'schema_version = "1.4"\n');
  await runCommand("tar", ["-czf", join(root, "task.tar.gz"), "-C", join(root, "task"), "."]);
  const store = new LocalArtifactStore(join(root, "store"));
  await store.put(
    "tasks/task.tar.gz",
    await readFile(join(root, "task.tar.gz")),
    "application/gzip",
  );
  const vault = memoryVault();
  const images = { provider: "modal", agent: "im-Agent1", verifier: "im-Verifier1" } as const;
  const input = await credentialedInput(vault, (value) => {
    value.sandbox = "modal";
    value.credentials = {
      ...(value.credentials ?? { modelCredentialId: "", provider: "openai" }),
      sandboxCredentialId: "managed-sandbox",
    };
    for (const task of value.tasks) task.images = images;
  });
  const calls: { name: string; args: readonly string[]; env?: NodeJS.ProcessEnv }[] = [];
  const command: typeof runCommand = async (name, args, options) => {
    calls.push({ name, args, ...(options?.env ? { env: options.env } : {}) });
    const stdout = args[0] === "--version" ? HARBOR_VERSION : "agent pinned im-Agent1\n";
    return { exitCode: 0, stdout, stderr: "" };
  };

  const outcome = await prepareTaskImages(store, trialInput(input, 0), {
    command,
    vault,
    env: {
      PATH: bin,
      SELFBENCH_MANAGED_OFFERING: "true",
      SELFBENCH_MANAGED_MODAL_TOKEN_ID: "modal-id",
      SELFBENCH_MANAGED_MODAL_TOKEN_SECRET: "modal-secret",
    },
  });

  expect(outcome).toBe("agent pinned im-Agent1");
  const build = calls.at(-1);
  expect(build?.name).toBe("/opt/uv-tools/harbor/bin/python");
  expect(build?.args[0]).toBe(join(harborPythonPath(), "selfbench_prepare.py"));
  expect(build?.args.slice(2)).toEqual([
    "modal",
    "agent_image=im-Agent1",
    "verifier_image=im-Verifier1",
  ]);
  expect(build?.env?.MODAL_TOKEN_SECRET).toBe("modal-secret");
  expect(build?.env?.PYTHONPATH).toBe(harborPythonPath());
});
