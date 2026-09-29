import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import { withExecutionEnvironment } from "../../src/contracts/config/execution-environment.js";
import type { AuthoredTask } from "../../src/contracts/index.js";
import { harborRun, runHarborGates } from "../../src/generation/pipeline/harbor-gates.js";
import { harborPythonPath } from "../../src/harnesses/harbor/command.js";
import { runCommand } from "../../src/lib/process.js";

test("generation gates run smoke as the agent, then the oracle, on the packaged E2B adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-gate-test-"));
  try {
    const executable = join(root, "harbor");
    await writeFile(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.23.0'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(join(root, "capture.json"))}, JSON.stringify({args, pythonPath: process.env.PYTHONPATH, key: process.env.E2B_API_KEY}));
const directory = path.join(args[args.indexOf('--jobs-dir')+1], args[args.indexOf('--job-name')+1]);
fs.mkdirSync(directory, {recursive:true});
fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({trial_results:[{ok:true}]}));
`,
    );
    await chmod(executable, 0o700);
    await writeFile(join(root, "task.toml"), 'schema_version = "1.4"\n');
    await mkdir(join(root, "jobs"));
    const capture = join(root, "capture.json");
    for (const [run, agent] of [
      ["nop", "harbor_smoke:SmokeAgent"],
      ["oracle", "oracle"],
    ] as const) {
      await withExecutionEnvironment(
        { PATH: root, CAPTURE: capture, SELFBENCH_HARBOR_E2B_API_KEY: "test-key" },
        () => harborRun(root, root, "task", run, "e2b", new AbortController().signal),
      );
      const recorded = JSON.parse(await readFile(capture, "utf8"));
      expect(recorded.args[recorded.args.indexOf("--env") + 1]).toBe("e2b");
      expect(recorded.args[recorded.args.indexOf("--agent") + 1]).toBe(agent);
      expect(recorded.pythonPath).toBe(harborPythonPath());
      expect(recorded.key).toBe("test-key");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gate version mismatch prevents any trial command", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-version-test-"));
  try {
    const executable = join(root, "harbor");
    const marker = join(root, "trial-started");
    await writeFile(
      executable,
      `#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('wrong-version')}else{require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')}\n`,
    );
    await chmod(executable, 0o700);
    await expect(
      withExecutionEnvironment({ PATH: root }, () =>
        harborRun(root, root, "task", "nop", "docker", new AbortController().signal),
      ),
    ).rejects.toThrow("does not match");
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a gate refuses a bundle that asks for the worker's credentials, without retrying", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-unsafe-gate-test-"));
  try {
    const executable = join(root, "harbor");
    const marker = join(root, "trial-started");
    await writeFile(
      executable,
      `#!${process.execPath}\nif(process.argv[2]==='--version'){console.log('0.23.0')}else{require('node:fs').writeFileSync(${JSON.stringify(marker)},'started')}\n`,
    );
    await chmod(executable, 0o700);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: exercises Harbor's host interpolation.
    await writeFile(join(root, "task.toml"), '[environment.env]\nLEAK = "${MODAL_TOKEN_SECRET}"\n');
    const failure = await withExecutionEnvironment(
      { PATH: root, MODAL_TOKEN_SECRET: "worker-secret" },
      () => harborRun(root, root, "task", "nop", "modal", new AbortController().signal),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect((failure as ApplicationFailure).nonRetryable).toBe(true);
    expect((failure as ApplicationFailure).message).toContain("environment.env");
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("smoke that fails under the agent's conditions stops the gates with advice for the author", async () => {
  const root = await mkdtemp(join(tmpdir(), "harbor-smoke-gate-test-"));
  try {
    // A fake Harbor whose smoke agent failed the way pnpm does behind the agent allowlist.
    const executable = join(root, "harbor");
    await writeFile(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.23.0'); process.exit(0); }
const trial = path.join(args[args.indexOf('--jobs-dir')+1], args[args.indexOf('--job-name')+1], 'trial');
fs.mkdirSync(trial, {recursive:true});
fs.writeFileSync(path.join(trial, '..', 'result.json'), '{}');
fs.writeFileSync(path.join(trial, 'result.json'), JSON.stringify({
  agent_result: {metadata: {smoke_exit_code: 1, smoke_output: 'Internal Error: Error when performing the request to https://registry.npmjs.org/pnpm'}},
  exception_info: {exception_type: 'SmokeCheckFailed', exception_message: 'smoke command exited 1'},
}));
`,
    );
    await chmod(executable, 0o700);
    const task = join(root, "bundle", "harbor-task");
    await mkdir(task, { recursive: true });
    await writeFile(join(task, "task.toml"), 'schema_version = "1.4"\n');
    await runCommand("tar", ["-czf", join(root, "task.tar.gz"), "-C", join(root, "bundle"), "."]);
    const store = new LocalArtifactStore(join(root, "store"));
    const bundle = await store.put(
      "bundle.tar.gz",
      await readFile(join(root, "task.tar.gz")),
      "application/gzip",
    );

    const gates = await withExecutionEnvironment({ PATH: `${root}:/usr/bin:/bin` }, () =>
      runHarborGates(
        store,
        { taskId: "task", bundle } as AuthoredTask,
        "docker",
        "verify/task",
        new AbortController().signal,
      ),
    );

    expect(gates.build.ok).toBe(true);
    expect(gates.smoke).toMatchObject({ ran: true, ok: false });
    expect(gates.smoke.logTail).toContain("exited 1 in the agent environment");
    expect(gates.smoke.logTail).toContain("network limited to the model provider");
    expect(gates.smoke.logTail).toContain("registry.npmjs.org/pnpm");
    expect(gates.nop.ran).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
