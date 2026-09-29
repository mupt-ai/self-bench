import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskDefinition } from "../../src/contracts/index.js";
import { passToPassTestPaths } from "../../src/generation/task/paths.js";
import { taskToml } from "../../src/generation/task/render.js";
import { testScript } from "../../src/generation/task/verifier.js";
import { runCommand } from "../../src/lib/process.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const task = {
  workdir: "project",
  testCommand:
    'for test in {tests}; do file="$(echo "$test" | sed "s/::.*//")"; [ ! -f "$file" ] || grep -qx base "$file" || exit 1; done',
  failToPass: ["tests/new.test"],
  passToPass: ["tests/regression.test::case", "tests/missing.test", "tests", "-x"],
  testPaths: ["tests/new.test"],
} as TaskDefinition;

const testPatch =
  "diff --git a/project/tests/new.test b/project/tests/new.test\nnew file mode 100644\n--- /dev/null\n+++ b/project/tests/new.test\n@@ -0,0 +1 @@\n+base\n";

describe("verifier script", () => {
  test("derives pass-to-pass file paths from selectors", () => {
    expect(passToPassTestPaths(task)).toEqual([
      "project/tests",
      "project/tests/missing.test",
      "project/tests/regression.test",
    ]);
    expect(passToPassTestPaths({ ...task, workdir: ".", passToPass: [".", "../x"] })).toEqual([]);
    expect(
      passToPassTestPaths({ ...task, passToPass: ["spec/a_spec.rb:42", "spec/b_spec.rb[1:2]"] }),
    ).toEqual(["project/spec/a_spec.rb", "project/spec/b_spec.rb"]);
  });

  test("grades pass-to-pass files at their base version and keeps the solver's source change", async () => {
    const { root, app, runVerifier } = await verifierFixture();
    await writeFile(join(app, "project/value.txt"), "new\n");
    await writeFile(join(app, "project/tests/regression.test"), "renamed\n");
    await writeFile(join(app, "project/tests/extra.test"), "solver test\n");
    await collectAgentPatch(root, app);

    expect(await runVerifier()).toMatchObject({ reward: 1, patch_applied: 1, pass_to_pass: 1 });
    expect(await readFile(join(root, "verifier/project/tests/regression.test"), "utf8")).toBe(
      "base\n",
    );
    expect(await readFile(join(root, "verifier/project/value.txt"), "utf8")).toBe("new\n");
    // Selectors naming a directory are not restored, so solver files beside the tests remain.
    expect(await readFile(join(root, "verifier/project/tests/extra.test"), "utf8")).toBe(
      "solver test\n",
    );
  });

  test("refuses a patch diffed against a baseline the root agent moved", async () => {
    const { root, app, runVerifier } = await verifierFixture();
    await writeFile(join(app, "project/value.txt"), "new\n");
    const baseline = ["--git-dir", join(root, "opt/base.git"), "--work-tree", app];
    await runCommand("git", [...baseline, "add", "-A"]);
    await runCommand("git", [...baseline, "commit", "-qm", "hide the change from the diff"]);
    await collectAgentPatch(root, app);

    expect(await runVerifier()).toMatchObject({ reward: 0, patch_applied: 0 });
    expect(await readFile(join(root, "verifier/project/value.txt"), "utf8")).toBe("old\n");
  });
});

/** The collect hook exactly as task.toml renders it, pointed at a local agent tree. */
async function collectAgentPatch(root: string, app: string): Promise<void> {
  const rendered = taskToml({
    ...task,
    timeouts: { setupSeconds: 1, agentSeconds: 1, testsSeconds: 1 },
    resources: { cpus: 1, memoryMb: 1, storageMb: 1 },
  } as TaskDefinition);
  const command = JSON.parse(/^command = (".*")$/m.exec(rendered)?.[1] ?? '""') as string;
  const result = await runCommand(
    "bash",
    ["-c", command.replaceAll("/opt/selfbench", join(root, "opt")).replaceAll("/app", app)],
    { allowFailure: true },
  );
  expect(result.exitCode).toBe(0);
}

/**
 * The agent tree (base commit, then the post-setup commit copied to base.git, as the agent
 * Dockerfile builds it) and a separate verifier tree still at the base commit.
 */
async function verifierFixture() {
  const root = await mkdtemp(join(tmpdir(), "selfbench-verifier-"));
  roots.push(root);
  const app = join(root, "app");
  const verifier = join(root, "verifier");
  await mkdir(join(app, "project/tests"), { recursive: true });
  await mkdir(join(root, "opt"));
  await runCommand("git", ["init", "-q", app]);
  await runCommand("git", ["-C", app, "config", "user.email", "test@example.com"]);
  await runCommand("git", ["-C", app, "config", "user.name", "Test"]);
  await writeFile(join(app, "project/value.txt"), "old\n");
  await writeFile(join(app, "project/tests/regression.test"), "base\n");
  await runCommand("git", ["-C", app, "add", "."]);
  await runCommand("git", ["-C", app, "commit", "-qm", "base"]);
  await runCommand("git", ["clone", "-q", app, verifier]);
  await runCommand("git", ["-C", app, "commit", "-qm", "selfbench-setup", "--allow-empty"]);
  await runCommand("cp", ["-a", join(app, ".git"), join(root, "opt/base.git")]);

  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests/test.patch"), testPatch);
  await writeFile(join(root, "command.sh"), 'run_verifier_command() { bash -c "$1"; }\n');
  const script = testScript(task, testPatch)
    .replaceAll("/app", verifier)
    .replaceAll("/opt/selfbench-runtime/command.sh", join(root, "command.sh"))
    .replaceAll("/opt/selfbench", join(root, "opt"))
    .replaceAll("/tests/test.patch", join(root, "tests/test.patch"))
    .replaceAll("/logs/verifier", join(root, "logs"))
    .replaceAll("pkill -KILL", "true");
  await writeFile(join(root, "test.sh"), script);
  const runVerifier = async () => {
    // Harbor runs test.sh as root over an /app the verifier user owns, which git treats as
    // another user's repository.
    await runCommand("bash", [join(root, "test.sh")], {
      allowFailure: true,
      env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" },
    });
    return JSON.parse(await readFile(join(root, "logs/reward.json"), "utf8")) as unknown;
  };
  return { root, app, runVerifier };
}
