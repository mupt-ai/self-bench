import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { withExecutionEnvironment } from "../../src/contracts/config/execution-environment.js";
import type { AuthoredTask } from "../../src/contracts/index.js";
import type { TaskImageBuilder } from "../../src/generation/images/builder.js";
import { runHarborGates } from "../../src/generation/pipeline/harbor-gates.js";
import { HARBOR_VERSION } from "../../src/harnesses/harbor/command.js";
import { gzippedTar } from "../support/tar.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const images = {
  agent: `localhost:5000/tasks/run/cand/agent@sha256:${"a".repeat(64)}`,
  verifier: `localhost:5000/tasks/run/cand/verifier@sha256:${"b".repeat(64)}`,
};

/** A fake `harbor` that records each run's task.toml and passes smoke, nop and oracle. */
async function harbor(root: string) {
  const executable = join(root, "harbor");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(${JSON.stringify(HARBOR_VERSION)}); process.exit(0); }
const task = args[args.indexOf('--path')+1];
const agent = args[args.indexOf('--agent')+1];
fs.appendFileSync(${JSON.stringify(join(root, "runs.log"))}, agent + '\\n' + fs.readFileSync(path.join(task, 'task.toml'), 'utf8') + '\\n---\\n');
const directory = path.join(args[args.indexOf('--jobs-dir')+1], args[args.indexOf('--job-name')+1]);
const trial = path.join(directory, 'trial-1');
fs.mkdirSync(trial, {recursive:true});
const rewards = agent === 'oracle' ? {patch_applied:1,setup_completed:1,fail_to_pass:1,pass_to_pass:1,deterministic:1} : {patch_applied:1,setup_completed:1,fail_to_pass:0,pass_to_pass:1};
fs.writeFileSync(path.join(trial, 'result.json'), JSON.stringify(fs.existsSync(${JSON.stringify(join(root, "fail-start"))}) ? {exception_info:{exception_type:'RuntimeError',exception_message:'manifest unknown'}} : {verifier_result:{rewards}}));
fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({trial_results:[{verifier_result:{rewards}}]}));
`,
  );
  await chmod(executable, 0o700);
}

async function attempt() {
  const root = await mkdtemp(join(tmpdir(), "selfbench-image-gates-"));
  roots.push(root);
  await harbor(root);
  const store = new LocalArtifactStore(join(root, "store"));
  const gate = await store.put(
    "runs/run/verify/cand/compile/attempt-1/gate-task.tar.gz",
    await gzippedTar({
      "harbor-task/task.toml": 'schema_version = "1.4"\n[verifier.environment]\ncpus = 1\n',
      "harbor-task/environment/Dockerfile": "FROM busybox\n",
      "harbor-task/tests/Dockerfile": "FROM busybox\n",
    }),
    "application/gzip",
  );
  const build = { runId: "run", candidateId: "cand", gate, snapshot: gate, prefix: "p" };
  const task = { taskId: "task", bundle: gate } as AuthoredTask;
  return { root, store, build, task };
}

const run = (root: string, gates: () => ReturnType<typeof runHarborGates>) =>
  withExecutionEnvironment({ PATH: `${root}:/usr/bin:/bin` }, gates);

test("both Harbor runs start from the images the build gate built", async () => {
  const { root, store, build, task } = await attempt();
  const builder: TaskImageBuilder = { build: async () => ({ images }) };
  const gates = await run(root, () =>
    runHarborGates(store, task, "docker", "verify/task", new AbortController().signal, {
      builder,
      build,
      serving: { env: {} },
    }),
  );
  expect(gates).toMatchObject({
    build: { ok: true },
    nop: { ok: true },
    oracle: { ok: true },
    images,
  });
  const runs = (await readFile(join(root, "runs.log"), "utf8"))
    .split("---")
    .filter((r) => r.trim());
  expect(runs).toHaveLength(2);
  for (const recorded of runs) {
    expect(recorded).toContain(`docker_image = "${images.agent}"`);
    expect(recorded).toContain(`docker_image = "${images.verifier}"`);
  }
});

test("a failed build is the author's build gate, and no Harbor run starts", async () => {
  const { root, store, build, task } = await attempt();
  const builder: TaskImageBuilder = {
    build: async () => ({ failure: "--- agent image build ---\nsetup.sh: pnpm: not found" }),
  };
  const gates = await run(root, () =>
    runHarborGates(store, task, "docker", "verify/task", new AbortController().signal, {
      builder,
      build,
      serving: { env: {} },
    }),
  );
  expect(gates.build).toMatchObject({ ran: true, ok: false, infrastructure: false });
  expect(gates.build.logTail).toContain("pnpm: not found");
  expect(gates.smoke.ran).toBe(false);
  expect(gates).not.toHaveProperty("images");
  expect(await Bun.file(join(root, "runs.log")).exists()).toBe(false);
});

test("a trial that cannot start from built images is retried, not charged to the author", async () => {
  const { root, store, build, task } = await attempt();
  const builder: TaskImageBuilder = { build: async () => ({ images }) };
  await writeFile(join(root, "fail-start"), "");
  await expect(
    withExecutionEnvironment({ PATH: `${root}:/usr/bin:/bin` }, () =>
      runHarborGates(store, task, "docker", "verify/task", new AbortController().signal, {
        builder,
        build,
        serving: { env: {} },
      }),
    ),
  ).rejects.toThrow("could not start task from its images: RuntimeError: manifest unknown");
});
