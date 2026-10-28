import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileHarborTask } from "../../src/generation/task/compiler.js";
import { COMPILER_REVISION } from "../../src/generation/task/constants.js";
import { runCommand } from "../../src/lib/process.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const authoredDockerfile = `FROM node:22-bookworm@sha256:${"a".repeat(64)}
ADD repo.tar.gz /app/
WORKDIR /app/project
RUN npm ci --ignore-scripts
`;

describe("Harbor task compiler", () => {
  test("builds a sealed native Harbor bundle from a pinned commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-compiler-"));
    roots.push(root);
    const repo = join(root, "repo");
    const output = join(root, "output");
    await mkdir(join(repo, "project"), { recursive: true });
    await runCommand("git", ["init", "-q", repo]);
    await runCommand("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await runCommand("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "value.txt"), "base\n");
    await writeFile(join(repo, "project/package.json"), '{"dependencies":{"left-pad":"1.0.0"}}\n');
    await runCommand("git", ["-C", repo, "add", "."]);
    await runCommand("git", ["-C", repo, "commit", "-qm", "base"]);
    const commit = (await runCommand("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();

    await compileHarborTask(
      {
        "instruction.md": "Implement the requested behavior.\n\n",
        Dockerfile: authoredDockerfile,
        "smoke.sh": "npm --version\n",
        "run-tests.sh": 'cd project && node --test "tests/$1"\n',
        "test.patch":
          "diff --git a/project/tests/new b/project/tests/new\nnew file mode 100644\n--- /dev/null\n+++ b/project/tests/new\n@@ -0,0 +1 @@\n+test\ndiff --git a/project/fixture.config.js b/project/fixture.config.js\nnew file mode 100644\n--- /dev/null\n+++ b/project/fixture.config.js\n@@ -0,0 +1 @@\n+export default {}\n",
        "gold.patch":
          "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-base\n+fixed\n",
      },
      {
        taskId: "example",
        difficulty: "medium",
        repo: "example/repo",
        baseCommit: commit,
        sourcePr: 1,
      },
      repo,
      output,
    );

    expect(await readFile(join(output, "instruction.md"), "utf8")).toBe(
      "Implement the requested behavior.\n",
    );
    const taskToml = await readFile(join(output, "task.toml"), "utf8");
    expect(taskToml).toContain('difficulty = "medium"');
    expect(taskToml).toContain(`base_commit = "${commit}"`);
    expect(taskToml).toContain("allowed_hosts = []");
    // The agent is root, like the Dockerfile's own steps, so it sees their HOME and caches. Its
    // time comes from the repository at each run, not the task.
    expect(taskToml).toContain('[agent]\nuser = "root"\nnetwork_mode = "allowlist"');

    // Both images are the author's Dockerfile, then the snapshot committed as /app's base.
    const agentDockerfile = await readFile(join(output, "environment/Dockerfile"), "utf8");
    const verifierDockerfile = await readFile(join(output, "tests/Dockerfile"), "utf8");
    for (const dockerfile of [agentDockerfile, verifierDockerfile]) {
      expect(dockerfile.startsWith(`${authoredDockerfile}USER root\n`)).toBe(true);
      expect(dockerfile).toContain("git -C /app --work-tree=/tmp/selfbench-repo add -A");
      expect(dockerfile).toContain("commit -qm base --no-verify");
      expect(dockerfile).not.toContain("gold.patch");
    }
    // agent.patch is diffed against the post-setup snapshot, so setup outputs that are not
    // gitignored never land in the agent's patch and never collide with the verifier's own.
    expect(agentDockerfile).toContain(
      "COPY smoke.sh /opt/selfbench-environment/\nRUN chmod 755 /opt/selfbench-environment/smoke.sh \\\n    && git -C /app add -A \\\n    && git -C /app -c core.hooksPath=/dev/null commit -qm selfbench-setup --allow-empty --no-verify \\\n    && mkdir -p /opt/selfbench \\\n    && cp -a /app/.git /opt/selfbench/base.git",
    );
    expect(agentDockerfile).not.toMatch(/useradd --create-home|ENV HOME|test\.patch/);
    expect(verifierDockerfile).toContain("useradd --create-home --shell /bin/bash verifier");
    expect(verifierDockerfile).toContain("chown -R verifier:verifier /app /home/verifier");
    expect(verifierDockerfile).toContain("COPY runtime/ run-tests.sh /opt/selfbench-runtime/");
    expect(verifierDockerfile).toContain("COPY test.patch test.sh /tests/");
    expect(verifierDockerfile).not.toContain("smoke.sh");

    expect(await readFile(join(output, "environment/smoke.sh"), "utf8")).toBe("npm --version\n");
    expect(await readFile(join(output, "tests/run-tests.sh"), "utf8")).toContain("node --test");
    for (const context of ["environment", "tests"]) {
      expect(await Bun.file(join(output, context, "repo.tar.gz")).exists()).toBe(true);
      expect(await Bun.file(join(output, context, "docker-compose.yaml")).exists()).toBe(false);
    }

    const verifier = await readFile(join(output, "tests/test.sh"), "utf8");
    expect(verifier).toContain("--exclude='project/fixture.config.js'");
    expect(verifier).toContain(
      "for protected_path in 'project/fixture.config.js' 'project/tests/new'; do",
    );
    expect(verifier).toContain(
      'run_verifier_command "bash /opt/selfbench-runtime/run-tests.sh fail-to-pass"',
    );
    expect(verifier).toContain('"fail_to_pass_exit_code": $fail_to_pass_exit_code');
    expect((await runCommand("bash", ["-n", join(output, "tests/test.sh")])).exitCode).toBe(0);
    const commandRunner = await readFile(join(output, "tests/runtime/command.sh"), "utf8");
    expect(commandRunner).toContain("runuser -u verifier --preserve-environment -- env");
    expect(commandRunner).toContain('HOME=/home/verifier bash -c "$command"');

    expect(
      JSON.parse(await readFile(join(output, ".selfbench-manifest.json"), "utf8")),
    ).toMatchObject({ compilerRevision: COMPILER_REVISION, taskId: "example" });
  });
});
