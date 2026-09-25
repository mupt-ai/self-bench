import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskDefinition } from "../../src/contracts/index.js";
import { passToPassTestPaths } from "../../src/generation/task/paths.js";
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
    const root = await mkdtemp(join(tmpdir(), "selfbench-verifier-"));
    roots.push(root);
    const app = join(root, "app");
    await mkdir(join(app, "project/tests"), { recursive: true });
    await runCommand("git", ["init", "-q", app]);
    await runCommand("git", ["-C", app, "config", "user.email", "test@example.com"]);
    await runCommand("git", ["-C", app, "config", "user.name", "Test"]);
    await writeFile(join(app, "project/value.txt"), "old\n");
    await writeFile(join(app, "project/tests/regression.test"), "base\n");
    await runCommand("git", ["-C", app, "add", "."]);
    await runCommand("git", ["-C", app, "commit", "-qm", "base"]);

    await writeFile(join(app, "project/value.txt"), "new\n");
    await writeFile(join(app, "project/tests/regression.test"), "renamed\n");
    await writeFile(join(app, "project/tests/extra.test"), "solver test\n");
    await runCommand("git", ["-C", app, "add", "-N", "."]);
    const agentPatch = (await runCommand("git", ["-C", app, "diff", "--binary"])).stdout;
    await runCommand("git", ["-C", app, "reset", "-q", "--hard"]);
    await runCommand("git", ["-C", app, "clean", "-fdq"]);

    await mkdir(join(root, "tests"));
    await writeFile(join(root, "agent.patch"), agentPatch);
    await writeFile(join(root, "tests/test.patch"), testPatch);
    await writeFile(join(root, "command.sh"), 'run_verifier_command() { bash -c "$1"; }\n');
    const script = testScript(task, testPatch)
      .replaceAll("/app", app)
      .replaceAll("/opt/selfbench-runtime/command.sh", join(root, "command.sh"))
      .replaceAll("/opt/selfbench/agent.patch", join(root, "agent.patch"))
      .replaceAll("/tests/test.patch", join(root, "tests/test.patch"))
      .replaceAll("/logs/verifier", join(root, "logs"))
      .replaceAll("pkill -KILL", "true");
    await writeFile(join(root, "test.sh"), script);
    await runCommand("bash", [join(root, "test.sh")], { allowFailure: true });

    expect(JSON.parse(await readFile(join(root, "logs/reward.json"), "utf8"))).toMatchObject({
      reward: 1,
      patch_applied: 1,
      pass_to_pass: 1,
    });
    expect(await readFile(join(app, "project/tests/regression.test"), "utf8")).toBe("base\n");
    expect(await readFile(join(app, "project/value.txt"), "utf8")).toBe("new\n");
    // Selectors naming a directory are not restored, so solver files beside the tests remain.
    expect(await readFile(join(app, "project/tests/extra.test"), "utf8")).toBe("solver test\n");
  });
});
