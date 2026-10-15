import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/local.js";
import { withExecutionEnvironment } from "../../src/contracts/config/execution-environment.js";
import type { AuthoredTask } from "../../src/contracts/index.js";
import { solverArguments } from "../../src/evaluation/solver-arguments.js";
import { unpackTrialTask } from "../../src/evaluation/task-bundle.js";
import { runHarborGates } from "../../src/generation/pipeline/harbor-gates.js";
import { runCommand } from "../../src/lib/process.js";
import { GATE_TASK_FILE, SNAPSHOT_FILE } from "../../src/sandbox/gate-bundle.js";
import { readSnapshotLink } from "../../src/sandbox/snapshot-link.js";

const roots: string[] = [];
const COMPILE = "runs/run-1/verify/cand-1/authoring-round-1/compile/attempt-1";
const DOCKERFILE = "FROM base\nCOPY repo.tar.gz /tmp/repo.tar.gz\nRUN true\n";
const images = { provider: "modal", agent: "im-Agent1", verifier: "im-Verifier1" } as const;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-pinned-images-"));
  roots.push(root);
  return root;
}

/** A compiled bundle (and, when `split`, the gate task and snapshot the compiler writes beside it). */
async function storedTask(store: LocalArtifactStore, split: boolean) {
  const source = await temporary();
  const task = join(source, "harbor-task");
  for (const context of ["environment", "tests"]) {
    await mkdir(join(task, context), { recursive: true });
    await writeFile(join(task, context, "Dockerfile"), DOCKERFILE);
  }
  await writeFile(join(task, "task.toml"), 'schema_version = "1.4"\n');
  await writeFile(join(task, "tests/test.sh"), "#!/bin/bash\n");
  const gate = join(source, "gate.tar.gz");
  await runCommand("tar", ["-czf", gate, "-C", source, "harbor-task"]);
  await writeFile(join(task, "environment/repo.tar.gz"), "snapshot");
  const full = join(source, "full.tar.gz");
  await runCommand("tar", ["-czf", full, "-C", source, "harbor-task"]);
  const bundle = await store.putFile(`${COMPILE}/harbor-task.tar.gz`, full, "application/gzip");
  if (split) {
    await store.putFile(`${COMPILE}/${GATE_TASK_FILE}`, gate, "application/gzip");
    await store.put(`${COMPILE}/${SNAPSHOT_FILE}`, Buffer.from("snapshot"), "application/gzip");
  }
  return bundle;
}

/**
 * Harbor stand-in: the smoke-and-nop run passes both, the oracle passes, and when given an image
 * record directory it writes the images its sandboxes "started from", as selfbench_modal.py does.
 */
async function fakeHarbor(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin);
  const capture = join(root, "calls.jsonl");
  await writeFile(
    join(bin, "harbor"),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.23.0'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args) + '\\n');
if (process.env.SELFBENCH_REGISTRY_HOST) {
  const toml = fs.readFileSync(path.join(args[args.indexOf('--path') + 1], 'task.toml'), 'utf8');
  if (!toml.includes('docker_image') || !toml.includes(process.env.SELFBENCH_REGISTRY_HOST)) throw new Error('gate did not use portable images');
}
const agent = args[args.indexOf('--agent') + 1];
const record = args.find((arg) => arg.startsWith('image_record_dir='));
if (record) {
  const directory = record.slice('image_record_dir='.length);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'agent'), 'im-Agent1\\n');
  fs.writeFileSync(path.join(directory, 'verifier'), 'im-Verifier1');
}
const smoke = agent !== 'oracle';
const rewards = smoke
  ? { patch_applied: 1, setup_completed: 1, fail_to_pass: 0, pass_to_pass: 1 }
  : { patch_applied: 1, setup_completed: 1, fail_to_pass: 1, pass_to_pass: 1, deterministic: 1 };
const job = path.join(args[args.indexOf('--jobs-dir') + 1], args[args.indexOf('--job-name') + 1]);
fs.mkdirSync(path.join(job, 'trial'), { recursive: true });
fs.writeFileSync(path.join(job, 'result.json'), '{}');
fs.writeFileSync(path.join(job, 'trial', 'result.json'), JSON.stringify({ verifier_result: { rewards }, ...(smoke ? { agent_result: { metadata: { smoke_exit_code: 0 } } } : {}) }));
`,
  );
  await chmod(join(bin, "harbor"), 0o700);
  return capture;
}

for (const environment of ["modal", "e2b"] as const) {
  test(`a ${environment} verification ${environment === "modal" ? "pins" : "does not pin"} the images its oracle ran on`, async () => {
    const root = await temporary();
    const store = new LocalArtifactStore(join(root, "store"));
    const bundle = await storedTask(store, false);
    const capture = await fakeHarbor(root);
    const task: AuthoredTask = {
      candidateId: "cand-1",
      taskId: "task-1",
      definition: bundle,
      sourceBundle: bundle,
      bundle,
    };

    const result = await withExecutionEnvironment(
      { PATH: `${join(root, "bin")}:/usr/bin:/bin` },
      () =>
        runHarborGates(store, task, environment, `${COMPILE}/gates`, new AbortController().signal),
    );

    expect(result.oracle.ok).toBe(true);
    const calls = (await readFile(capture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.map((args) => args[args.indexOf("--agent") + 1])).toEqual([
      "harbor_smoke:SmokeAgent",
      "oracle",
    ]);
    if (environment === "modal") {
      expect(result.images).toEqual(images);
      // Only the oracle, which runs the task's real test.sh, records what trials will start from.
      expect(calls.map((args) => args.includes("--ek"))).toEqual([false, true]);
      expect(calls[1]?.[calls[1].indexOf("--env") + 1]).toBe(
        "selfbench_modal:SelfBenchModalEnvironment",
      );
    } else {
      expect(result.images).toBeUndefined();
      expect(calls.flat()).not.toContain("--ek");
    }
  });
}

for (const environment of ["docker", "modal", "e2b", "daytona", "vercel"] as const) {
  test(`portable ${environment} gates run the same digest pair without rebuilding source`, async () => {
    const root = await temporary();
    const store = new LocalArtifactStore(join(root, "store"));
    const bundle = await storedTask(store, false);
    const capture = await fakeHarbor(root);
    const registry = {
      agent: `us-central1-docker.pkg.dev/p/tasks/task@sha256:${"a".repeat(64)}`,
      verifier: `us-central1-docker.pkg.dev/p/tasks/task@sha256:${"b".repeat(64)}`,
    };
    const task: AuthoredTask = {
      candidateId: "cand-1",
      taskId: "portable",
      definition: bundle,
      sourceBundle: bundle,
      bundle,
      images: { provider: "oci", registry },
    };
    const result = await withExecutionEnvironment(
      {
        PATH: `${join(root, "bin")}:/usr/bin:/bin`,
        SELFBENCH_TASK_IMAGE_REPOSITORY: "us-central1-docker.pkg.dev/p/tasks",
      },
      () =>
        runHarborGates(
          store,
          task,
          environment,
          `${COMPILE}/portable`,
          new AbortController().signal,
          undefined,
          {
            url: "https://app.selfbench.test",
            secret: "s".repeat(32),
          },
        ),
    );
    expect(result.oracle.ok).toBe(true);
    expect(result.images).toEqual(task.images);
    const calls = (await readFile(capture, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls).toHaveLength(2);
    expect(calls.flat().some((arg) => arg.startsWith("image_record_dir="))).toBe(false);
  });
}

test("a Modal trial starts from the pinned images; other backends build the Dockerfiles", () => {
  const modal = solverArguments(
    "/task",
    "/jobs",
    "codex",
    "openai/gpt-6",
    "modal",
    "high",
    [],
    images,
  );
  const pins = modal.flatMap((arg, index) => (modal[index - 1] === "--ek" ? [arg] : []));
  expect(pins).toEqual(["agent_image=im-Agent1", "verifier_image=im-Verifier1"]);
  const e2b = solverArguments("/task", "/jobs", "codex", "openai/gpt-6", "e2b", "high", [], images);
  expect(e2b).not.toContain("--ek");
  expect(e2b[e2b.indexOf("--env") + 1]).toBe("selfbench_e2b:SelfBenchE2BEnvironment");
});

test("a Modal trial reads the gate task and fetches the snapshot through its verification's link", async () => {
  const root = await temporary();
  const store = new LocalArtifactStore(join(root, "store"));
  await storedTask(store, true);
  const snapshotLink = { url: "https://selfbench.test", secret: "s".repeat(32) };
  const task = { runId: "run-1", taskId: "task-1", bundleKey: `${COMPILE}/harbor-task.tar.gz` };

  const modalRoot = await temporary();
  const modal = await unpackTrialTask(store, task, "modal", modalRoot, { snapshotLink });
  const snapshot = await store.stat(`${COMPILE}/${SNAPSHOT_FILE}`);
  for (const context of ["environment", "tests"]) {
    const [, add] = (await readFile(join(modal, context, "Dockerfile"), "utf8")).split("\n");
    const [, checksum, url] = add?.split(" ") ?? [];
    expect(checksum).toBe(`--checksum=sha256:${snapshot?.sha256}`);
    expect(readSnapshotLink(new URL(url ?? "").pathname, snapshotLink.secret)).toEqual({
      key: `${COMPILE}/${SNAPSHOT_FILE}`,
      sha256: snapshot?.sha256 ?? "",
    });
  }
  expect(await Bun.file(join(modal, "environment/repo.tar.gz")).exists()).toBe(false);

  const dockerRoot = await temporary();
  const docker = await unpackTrialTask(store, task, "docker", dockerRoot, { snapshotLink });
  expect(await readFile(join(docker, "environment/Dockerfile"), "utf8")).toBe(DOCKERFILE);
  expect(await readFile(join(docker, "environment/repo.tar.gz"), "utf8")).toBe("snapshot");
});

test("a Modal trial of a compile without the split files unpacks the full bundle", async () => {
  const root = await temporary();
  const store = new LocalArtifactStore(join(root, "store"));
  await storedTask(store, false);
  const task = { runId: "run-1", taskId: "task-1", bundleKey: `${COMPILE}/harbor-task.tar.gz` };
  const directory = await unpackTrialTask(store, task, "modal", await temporary(), {
    snapshotLink: { url: "https://selfbench.test", secret: "s".repeat(32) },
  });
  expect(await readFile(join(directory, "environment/Dockerfile"), "utf8")).toBe(DOCKERFILE);
  expect(await readFile(join(directory, "environment/repo.tar.gz"), "utf8")).toBe("snapshot");
});
