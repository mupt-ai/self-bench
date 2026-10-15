import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/local.js";
import { withExecutionEnvironment } from "../../src/contracts/config/execution-environment.js";
import type { AuthoredTask } from "../../src/contracts/index.js";
import { runHarborGates } from "../../src/generation/pipeline/harbor-gates.js";
import { runCommand } from "../../src/lib/process.js";

const COMPILE = "runs/run-1/verify/cand-1/authoring-round-1/compile/attempt-1";
const DOCKERFILE = "FROM base\nCOPY repo.tar.gz /tmp/repo.tar.gz\nRUN true\n";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "selfbench-portable-gates-"));
  roots.push(root);
  return root;
}
async function storedTask(store: LocalArtifactStore) {
  const root = await temporary();
  const task = join(root, "harbor-task");
  for (const context of ["environment", "tests"]) {
    await mkdir(join(task, context), { recursive: true });
    await writeFile(join(task, context, "Dockerfile"), DOCKERFILE);
  }
  await writeFile(join(task, "task.toml"), 'schema_version = "1.4"\n');
  await writeFile(join(task, "tests/test.sh"), "#!/bin/bash\n");
  const archive = join(root, "bundle.tar.gz");
  await runCommand("tar", ["-czf", archive, "-C", root, "harbor-task"]);
  const bundle = await store.putFile(`${COMPILE}/harbor-task.tar.gz`, archive, "application/gzip");
  return bundle;
}
async function fakeHarbor(root: string) {
  const bin = join(root, "bin");
  await mkdir(bin);
  const capture = join(root, "calls.jsonl");
  await writeFile(
    join(bin, "harbor"),
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
if(args[0]==='--version'){console.log('0.23.0');process.exit(0)}
fs.appendFileSync(${JSON.stringify(capture)},JSON.stringify(args)+'\\n');
if(process.env.SELFBENCH_REGISTRY_HOST){const toml=fs.readFileSync(path.join(args[args.indexOf('--path')+1],'task.toml'),'utf8');if(!toml.includes(process.env.SELFBENCH_REGISTRY_HOST))throw Error('portable image not used')}
const agent=args[args.indexOf('--agent')+1],smoke=agent!=='oracle',job=path.join(args[args.indexOf('--jobs-dir')+1],args[args.indexOf('--job-name')+1]);
const rewards=smoke?{patch_applied:1,setup_completed:1,fail_to_pass:0,pass_to_pass:1}:{patch_applied:1,setup_completed:1,fail_to_pass:1,pass_to_pass:1,deterministic:1};
fs.mkdirSync(path.join(job,'trial'),{recursive:true});fs.writeFileSync(path.join(job,'result.json'),'{}');fs.writeFileSync(path.join(job,'trial','result.json'),JSON.stringify({verifier_result:{rewards},...(smoke?{agent_result:{metadata:{smoke_exit_code:0}}}:{})}));
`,
  );
  await chmod(join(bin, "harbor"), 0o700);
  return capture;
}
for (const environment of ["docker", "modal", "e2b", "daytona", "vercel"] as const) {
  test(`portable ${environment} gates run the same digest pair without rebuilding source`, async () => {
    const root = await temporary();
    const store = new LocalArtifactStore(join(root, "store"));
    const bundle = await storedTask(store);
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
          { url: "https://app.selfbench.test", secret: "s".repeat(32) },
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
