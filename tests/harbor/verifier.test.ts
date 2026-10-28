import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskToml } from "../../src/generation/task/render.js";
import { testScript } from "../../src/generation/task/verifier.js";
import { runCommand } from "../../src/lib/process.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const testPatch =
  "diff --git a/tests/new.test b/tests/new.test\nnew file mode 100644\n--- /dev/null\n+++ b/tests/new.test\n@@ -0,0 +1 @@\n+held out\n";

// Fail-to-pass needs the fix and the held-out test as test.patch wrote it; pass-to-pass needs the
// existing behavior.
const runTests = `case "$1" in
  fail-to-pass) grep -qx fixed value.txt && grep -qx "held out" tests/new.test ;;
  pass-to-pass) grep -qx kept keep.txt ;;
esac
`;

describe("verifier script", () => {
  test("grades the solver's source change over the held-out tests as test.patch wrote them", async () => {
    const { root, app, runVerifier } = await verifierFixture();
    await writeFile(join(app, "value.txt"), "fixed\n");
    await writeFile(join(app, "tests/new.test"), "solver's own version\n");
    await collectAgentPatch(root, app);

    expect(await runVerifier()).toMatchObject({
      reward: 1,
      patch_applied: 1,
      fail_to_pass: 1,
      deterministic: 1,
      pass_to_pass: 1,
    });
    expect(await readFile(join(root, "verifier/tests/new.test"), "utf8")).toBe("held out\n");
  });

  test("fails the task when the solver breaks the existing behavior", async () => {
    const { root, app, runVerifier } = await verifierFixture();
    await writeFile(join(app, "value.txt"), "fixed\n");
    await writeFile(join(app, "keep.txt"), "broken\n");
    await collectAgentPatch(root, app);

    expect(await runVerifier()).toMatchObject({ reward: 0, fail_to_pass: 1, pass_to_pass: 0 });
  });

  test("refuses a patch diffed against a baseline the root agent moved", async () => {
    const { root, app, runVerifier } = await verifierFixture();
    await writeFile(join(app, "value.txt"), "fixed\n");
    const baseline = ["--git-dir", join(root, "opt/base.git"), "--work-tree", app];
    await runCommand("git", [...baseline, "add", "-A"]);
    await runCommand("git", [...baseline, "commit", "-qm", "hide the change from the diff"]);
    await collectAgentPatch(root, app);

    expect(await runVerifier()).toMatchObject({ reward: 0, patch_applied: 0 });
    expect(await readFile(join(root, "verifier/value.txt"), "utf8")).toBe("base\n");
  });
});

/** The collect hook exactly as task.toml renders it, pointed at a local agent tree. */
async function collectAgentPatch(root: string, app: string): Promise<void> {
  const rendered = taskToml({
    taskId: "task",
    difficulty: "easy",
    repo: "example/repo",
    baseCommit: "a".repeat(40),
    sourcePr: 1,
  });
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
  await mkdir(join(app, "tests"), { recursive: true });
  await mkdir(join(root, "opt"));
  await runCommand("git", ["init", "-q", app]);
  await runCommand("git", ["-C", app, "config", "user.email", "test@example.com"]);
  await runCommand("git", ["-C", app, "config", "user.name", "Test"]);
  await writeFile(join(app, "value.txt"), "base\n");
  await writeFile(join(app, "keep.txt"), "kept\n");
  await runCommand("git", ["-C", app, "add", "."]);
  await runCommand("git", ["-C", app, "commit", "-qm", "base"]);
  await runCommand("git", ["clone", "-q", app, verifier]);
  await runCommand("git", ["-C", app, "commit", "-qm", "selfbench-setup", "--allow-empty"]);
  await runCommand("cp", ["-a", join(app, ".git"), join(root, "opt/base.git")]);

  await mkdir(join(root, "tests"));
  await writeFile(join(root, "tests/test.patch"), testPatch);
  await writeFile(join(root, "run-tests.sh"), runTests);
  await writeFile(join(root, "command.sh"), 'run_verifier_command() { bash -c "$1"; }\n');
  const script = testScript(testPatch)
    .replaceAll("/app", verifier)
    .replaceAll("/opt/selfbench-runtime/command.sh", join(root, "command.sh"))
    .replaceAll("/opt/selfbench-runtime/run-tests.sh", join(root, "run-tests.sh"))
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
