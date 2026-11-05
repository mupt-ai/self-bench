import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "../src/lib/process.js";
import { compileSubmission, type TaskCompilerServices } from "../src/sandbox/task-compiler.js";
import { submission } from "./support/submission-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const digest = `sha256:${"d".repeat(64)}`;
const services: TaskCompilerServices = {
  cloneRepository: async () => {
    throw new Error("a scenario never clones its repository");
  },
  registry: {
    fetch: (async () =>
      new Response(null, {
        status: 200,
        headers: { "docker-content-digest": digest },
      })) as unknown as typeof fetch,
  },
};

/** The reference outcome: three lines, far below a pull request's easiest tier. */
const goldPatch = `diff --git a/answer.json b/answer.json
new file mode 100644
--- /dev/null
+++ b/answer.json
@@ -0,0 +1 @@
+{"team": 3, "date": "2026-11-10"}
`;
const testPatch = `diff --git a/tests/check.sh b/tests/check.sh
new file mode 100644
--- /dev/null
+++ b/tests/check.sh
@@ -0,0 +1 @@
+grep -q '"team": 3' answer.json
`;
const workspace = {
  "schedule.csv": "team,date\n6,2026-11-10\n3,2026-11-10\n",
  "mail/2026-11-01-trade.eml": "Subject: Trade\n\nAvyay moves to team 3.\n",
};

const scenario = { kind: "scenario" as const, title: "Traded", difficulty: "medium" as const };

async function draft(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-scenario-"));
  roots.push(root);
  const directory = join(root, "submission");
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(directory, name)), { recursive: true });
    await writeFile(join(directory, name), contents);
  }
  return directory;
}

const scenarioFiles: Record<string, string> = {
  ...submission,
  Dockerfile: "FROM python:3.12-bookworm\nADD repo.tar.gz /app/\n",
  "gold.patch": goldPatch,
  "test.patch": testPatch,
  ...Object.fromEntries(
    Object.entries(workspace).map(([path, text]) => [`workspace/${path}`, text]),
  ),
};

async function compiled(directory: string) {
  const result = await compileSubmission(
    {
      repositoryUrl: "https://github.com/example/repo",
      directory,
      taskId: "traded",
      candidate: scenario,
    },
    services,
  );
  expect(result).toMatchObject({ compileErrors: [], auditBlockers: [] });
  const output = await mkdtemp(join(tmpdir(), "selfbench-scenario-out-"));
  roots.push(output);
  await writeFile(join(output, "bundle.tar.gz"), result.bundle ?? new Uint8Array());
  await runCommand("tar", ["-xzf", join(output, "bundle.tar.gz"), "-C", output]);
  return join(output, "harbor-task");
}

test("a scenario compiles over the workspace its author wrote, at the requested tier", async () => {
  const task = await compiled(await draft(scenarioFiles));
  const snapshot = join(task, "environment/repo.tar.gz");
  const listing = (await runCommand("tar", ["-tzf", snapshot])).stdout.split("\n").filter(Boolean);
  expect(listing.filter((path) => !path.endsWith("/")).sort()).toEqual(
    Object.keys(workspace).sort(),
  );
  const toml = await readFile(join(task, "task.toml"), "utf8");
  expect(toml).toContain('source = "scenario"');
  expect(toml).toContain('scenario_title = "Traded"');
  expect(toml).toContain('difficulty = "medium"');
  expect(toml).not.toContain("source_pr");
  expect(await readFile(join(task, "solution/gold.patch"), "utf8")).toBe(goldPatch);
});

test("the same workspace always makes the same snapshot", async () => {
  const first = await compiled(await draft(scenarioFiles));
  const second = await compiled(await draft(scenarioFiles));
  const bytes = (task: string) => readFile(join(task, "environment/repo.tar.gz"));
  expect((await bytes(first)).equals(await bytes(second))).toBe(true);
});

test("a scenario without a usable workspace is the author's to fix", async () => {
  const compile = async (files: Record<string, string>) =>
    (
      await compileSubmission(
        {
          repositoryUrl: "https://github.com/example/repo",
          directory: await draft(files),
          taskId: "traded",
          candidate: scenario,
        },
        services,
      )
    ).compileErrors;
  const bare = Object.fromEntries(
    Object.entries(scenarioFiles).filter(([path]) => !path.startsWith("workspace/")),
  );
  expect((await compile(bare))[0]).toContain("workspace/ is missing");
  const errors = await compile({ ...scenarioFiles, "workspace/.git/HEAD": "ref: main\n" });
  expect(errors).toEqual([expect.stringContaining("workspace/.git must not exist")]);
});

/** A repository at one commit, for a repository scenario to start from. */
async function repositoryAt(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "selfbench-scenario-repo-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), contents);
  }
  const git = (...args: string[]) => runCommand("git", ["-C", root, ...args]);
  await git("init", "-q");
  await git("add", "-A");
  await git("-c", "user.name=a", "-c", "user.email=a@a", "commit", "-qm", "base");
  return { root, commit: (await git("rev-parse", "HEAD")).stdout.trim() };
}

const repositoryFiles = { "app/page.tsx": "export default function Page() {}\n" };
const repositoryScenarioFiles = Object.fromEntries(
  Object.entries(scenarioFiles).filter(([path]) => !path.startsWith("workspace/")),
);

test("a repository scenario compiles over its commit, at the requested tier", async () => {
  const repository = await repositoryAt(repositoryFiles);
  const cloned: string[] = [];
  const result = await compileSubmission(
    {
      repositoryUrl: "https://github.com/example/repo",
      directory: await draft(repositoryScenarioFiles),
      taskId: "dashboard",
      candidate: { ...scenario, title: "Dashboard", baseCommit: repository.commit },
    },
    {
      ...services,
      cloneRepository: async (_url, commit, destination) => {
        cloned.push(commit);
        await runCommand("git", ["clone", "-q", repository.root, destination]);
        await runCommand("git", ["-C", destination, "checkout", "-q", commit]);
      },
    },
  );
  // Its three-line gold is below a PR's easiest tier, and it has no workspace/: neither blocks it.
  expect(result).toMatchObject({ compileErrors: [], auditBlockers: [] });
  expect(cloned).toEqual([repository.commit]);
  const output = await mkdtemp(join(tmpdir(), "selfbench-scenario-out-"));
  roots.push(output);
  await writeFile(join(output, "bundle.tar.gz"), result.bundle ?? new Uint8Array());
  await runCommand("tar", ["-xzf", join(output, "bundle.tar.gz"), "-C", output]);
  const task = join(output, "harbor-task");
  const listing = (await runCommand("tar", ["-tzf", join(task, "environment/repo.tar.gz")])).stdout
    .split("\n")
    .filter((path) => path && !path.endsWith("/"));
  expect(listing).toEqual(Object.keys(repositoryFiles));
  const toml = await readFile(join(task, "task.toml"), "utf8");
  // Public downloads pack only a workspace scenario's snapshot as one (task-archive.ts).
  expect(toml).toContain('source = "repository_scenario"');
  expect(toml).toContain(`base_commit = "${repository.commit}"`);
  expect(toml).toContain('difficulty = "medium"');
  expect(toml).not.toContain("workspace_commit");
});

test("the static check holds a repository scenario to its requested tier, not a PR's", async () => {
  const repository = await repositoryAt(repositoryFiles);
  const program = join(import.meta.dir, "../src/sandbox/programs/check.ts");
  const directory = await draft(repositoryScenarioFiles);
  const check = async (...flags: string[]) =>
    JSON.parse(
      (
        await runCommand(process.execPath, [
          program,
          directory,
          "medium",
          repository.root,
          repository.commit,
          ...flags,
        ])
      ).stdout,
    ) as { ok: boolean; errors: string[] };
  expect(await check("--scenario-audit")).toEqual({ ok: true, errors: [] });
  expect((await check()).errors.join("\n")).toContain("even easy needs at least 20");
});

test("the static check proves both patches against the workspace", async () => {
  const program = join(import.meta.dir, "../src/sandbox/programs/check.ts");
  const check = async (files: Record<string, string>) =>
    JSON.parse(
      (await runCommand(process.execPath, [program, await draft(files), "easy", "--scenario"]))
        .stdout,
    ) as { ok: boolean; errors: string[] };
  expect(await check(scenarioFiles)).toEqual({ ok: true, errors: [] });
  const conflicting = goldPatch.replaceAll("answer.json", "schedule.csv");
  const result = await check({ ...scenarioFiles, "gold.patch": conflicting });
  expect(result.ok).toBe(false);
  expect(result.errors.join("\n")).toContain("gold.patch does not apply to the clean base tree");
});
