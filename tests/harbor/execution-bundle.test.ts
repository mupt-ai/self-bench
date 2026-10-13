import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";
import { LocalArtifactStore } from "../../src/artifacts/local.js";
import type { AuthoredTask } from "../../src/contracts/index.js";
import { unpackTrialTask } from "../../src/evaluation/task-bundle.js";
import { publishExecutionBundle } from "../../src/generation/pipeline/execution-bundle.js";
import { candidateArtifacts } from "../../src/generation/runs/artifacts.js";
import { assertHostSafeTask } from "../../src/harnesses/harbor/task-safety.js";
import { runCommand } from "../../src/lib/process.js";
import { taskArchive } from "../../src/public/task-archive.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const files = {
  "instruction.md": "Fix the application.\n",
  "task.toml":
    '[agent]\nnetwork_mode = "allowlist"\nallowed_hosts = []\n[environment]\ncpus = 2\nmemory_mb = 2048\n[verifier]\nenvironment_mode = "separate"\n[[verifier.collect]]\ncommand = "collect-agent-patch"\n[verifier.environment]\ncpus = 2\nmemory_mb = 2048\n',
  "environment/Dockerfile": "FROM agent-build\nCOPY repo.tar.gz /tmp/repo.tar.gz\n",
  "environment/repo.tar.gz": "large-repo",
  "environment/setup.sh": "setup",
  "environment/root-setup.sh": "root setup",
  "environment/smoke.sh": "smoke",
  "tests/Dockerfile": "FROM verifier-build\n",
  "tests/runtime/command.sh": "already in verifier image",
  "tests/repo.tar.gz": "large-repo",
  "tests/test.sh": "#!/bin/bash\ncat /tests/test.patch\n",
  "tests/test.patch": "hidden-tests",
  "tests/dependency-setup.patch": "already in verifier image",
  "solution/solve.sh": "#!/bin/bash\ncat /solution/gold.patch\n",
  "solution/gold.patch": "reference-fix",
  "definition.json": "compiler-input",
  ".selfbench-manifest.json": "compiler-provenance",
};
const delivered = [
  "environment/Dockerfile",
  "instruction.md",
  "solution/gold.patch",
  "solution/solve.sh",
  "task.toml",
  "tests/Dockerfile",
  "tests/test.patch",
  "tests/test.sh",
];
async function fixture(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "selfbench-native-task-"));
  roots.push(root);
  const store = new LocalArtifactStore(join(root, "store"));
  const source = join(root, "source", "harbor-task");
  for (const [path, text] of Object.entries({ ...files, ...extra })) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await writeFile(join(source, path), text);
  }
  const archive = join(root, "compiled.tar.gz");
  await runCommand("tar", ["-czf", archive, "-C", dirname(source), "harbor-task"]);
  const bundle = await store.putFile(
    "runs/run-native/verify/candidate/authoring-round-1/harbor-task.tar.gz",
    archive,
    "application/gzip",
  );
  // Split sibling must never be selected for the new execution bundle.
  await store.putFile(
    "runs/run-native/verify/candidate/authoring-round-1/gate-task.tar.gz",
    archive,
    "application/gzip",
  );
  const task: AuthoredTask = {
    candidateId: "candidate",
    taskId: "task",
    bundle,
    definition: bundle,
    sourceBundle: bundle,
    images: {
      provider: "modal",
      agent: "im-agent",
      verifier: "im-verifier",
      registry: {
        agent: `registry.example/tasks/agent@sha256:${"a".repeat(64)}`,
        verifier: `registry.example/tasks/verifier@sha256:${"b".repeat(64)}`,
      },
    },
  };
  return { root, store, task };
}

test("accepted tasks deliver native Harbor files, while build inputs remain immutable provenance", async () => {
  const { root, store, task } = await fixture();
  const result = await publishExecutionBundle(store, task, new AbortController().signal);
  expect(result.bundle.uri).not.toBe(task.bundle.uri);
  expect(result.definition).toEqual(task.definition);
  expect(result.sourceBundle).toEqual(task.sourceBundle);
  expect(await store.get(task.bundle)).toEqual(await readFile(join(root, "compiled.tar.gz")));
  const bundleKey = result.bundle.uri.slice(result.bundle.uri.indexOf("/runs/") + 1);
  const trial = join(root, "trial");
  await mkdir(trial);
  const directory = await unpackTrialTask(
    store,
    {
      runId: "run-native",
      taskId: "task",
      bundleKey,
      ...(result.images ? { images: result.images } : {}),
    },
    "modal",
    trial,
    {},
  );
  const listing = await runCommand("find", [directory, "-type", "f"]);
  expect(
    listing.stdout
      .trim()
      .split("\n")
      .map((path) => path.slice(directory.length + 1))
      .sort(),
  ).toEqual(delivered);
  expect(await readFile(join(directory, "environment/Dockerfile"), "utf8")).toBe(
    `FROM ${task.images?.registry?.agent}\n`,
  );
  expect(await readFile(join(directory, "tests/Dockerfile"), "utf8")).toBe(
    `FROM ${task.images?.registry?.verifier}\n`,
  );
  expect(await readFile(join(directory, "tests/test.patch"), "utf8")).toBe("hidden-tests");
  await assertHostSafeTask(directory, {}, 60);
  const config = parse(await readFile(join(directory, "task.toml"), "utf8"));
  expect(config.verifier).toMatchObject({
    environment_mode: "separate",
    collect: [{ command: "collect-agent-patch" }],
    environment: { cpus: 2, memory_mb: 2048 },
  });
  expect(config.environment).toMatchObject({ cpus: 2, memory_mb: 2048 });
  const found = await candidateArtifacts(store, "run-native", {
    candidateId: "candidate",
    taskId: "task",
  });
  expect(found.bundles[0]?.key).toBe(bundleKey);
  const download = await taskArchive(store, bundleKey, "task");
  expect(download).toBeDefined();
  if (!download) throw new Error("Missing public archive");
  await writeFile(join(root, "download.tar.gz"), download.bytes);
  const downloaded = await runCommand("tar", ["-tzf", join(root, "download.tar.gz")]);
  expect(downloaded.stdout.trim().split("\n").sort()).toEqual(delivered.map((f) => `task/${f}`));
  const retried = await publishExecutionBundle(store, task, new AbortController().signal);
  expect(retried.bundle).toEqual(result.bundle);
  expect(await publishExecutionBundle(store, result, new AbortController().signal)).toBe(result);
});

test("tasks without both exported images retain runnable build bundles", async () => {
  const { store, task } = await fixture();
  const unexported = { ...task, images: { provider: "modal" as const, agent: "im-agent" } };
  expect(await publishExecutionBundle(store, unexported, new AbortController().signal)).toBe(
    unexported,
  );
  if (!task.images?.registry) throw new Error("Missing fixture images");
  const noVerifier = {
    ...task,
    images: { ...task.images, registry: { agent: task.images.registry.agent } },
  };
  expect(await publishExecutionBundle(store, noVerifier, new AbortController().signal)).toBe(
    noVerifier,
  );
});

test("native execution bundles retain service compose contexts and reject invalid image references", async () => {
  const compose = `{"services":{"main":{"build":"."},"redis":{"image":"redis@sha256:${"c".repeat(64)}"}}}\n`;
  const { root, store, task } = await fixture({ "tests/docker-compose.yaml": compose });
  const result = await publishExecutionBundle(store, task, new AbortController().signal);
  const archive = join(root, "native.tar.gz");
  await writeFile(archive, await store.get(result.bundle));
  const directory = join(root, "extracted");
  await mkdir(directory);
  await runCommand("tar", ["-xzf", archive, "-C", directory]);
  expect(await readFile(join(directory, "harbor-task/tests/docker-compose.yaml"), "utf8")).toBe(
    compose,
  );
  if (!task.images?.registry) throw new Error("Missing fixture images");
  await expect(
    publishExecutionBundle(
      store,
      {
        ...task,
        images: {
          ...task.images,
          registry: { agent: "image\nRUN malicious", verifier: task.images.registry.verifier },
        },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("Invalid environment image digest");
});
