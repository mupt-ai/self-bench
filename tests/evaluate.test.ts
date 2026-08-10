import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMatrix, summarizeResult } from "../src/evaluate.js";
import { runCommand } from "../src/process.js";

describe("matrix result summary", () => {
  test("accepts a Harbor trial only when every reward passes", () => {
    const summary = summarizeResult("task-a", "gpt-5.6-sol", "job-a", {
      trial_results: [
        {
          verifier_result: {
            rewards: { fail_to_pass: 1, pass_to_pass: 1, setup_completed: 1 },
          },
        },
      ],
    });
    expect(summary.passed).toBe(true);
    expect(summary.rewards.fail_to_pass).toBe(1);
  });

  test("preserves trial exceptions", () => {
    const summary = summarizeResult("task-a", "gpt-5.6-luna", "job-a", {
      trial_results: [{ exception_info: { message: "sandbox failed" } }],
    });
    expect(summary.passed).toBe(false);
    expect(summary.exception).toBe("sandbox failed");
  });

  test("accepts a reward with zero-valued diagnostic fields", () => {
    const summary = summarizeResult("task-a", "gpt-5.6-terra", "job-a", {
      verifier_result: {
        rewards: {
          reward: 1,
          patch_applied: 1,
          fail_to_pass: 1,
          pass_to_pass: 1,
          deterministic: 1,
          setup_completed: 1,
          fail_to_pass_exit_code: 0,
        },
      },
    });
    expect(summary.passed).toBe(true);
  });

  test("does not pass a trial with no verifier rewards", () => {
    const summary = summarizeResult("task-a", "gpt-5.6-terra", "job-a", {
      trial_results: [{ verifier_result: { rewards: {} } }],
    });
    expect(summary.passed).toBe(false);
  });
});

describe("matrix task inputs", () => {
  test("accepts an expanded task directory with fewer than 10 tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-evaluate-test-"));
    const tasks = join(root, "tasks");
    await mkdir(join(tasks, "task-a"), { recursive: true });
    await writeFile(join(tasks, "task-a", "task.toml"), 'schema_version = "1.4"\n');
    await writeFile(
      join(root, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "token" } }),
    );
    const progress: string[] = [];
    const results = await runMatrix({
      tasksPath: tasks,
      jobsDirectory: join(root, "jobs"),
      authPath: join(root, "auth.json"),
      harborPath: "false",
      models: ["gpt-5.6-sol"],
      onTrialComplete: (summary, completed, total) => {
        progress.push(`${summary.model}:${completed}/${total}`);
      },
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.model).toBe("gpt-5.6-sol");
    expect(results[0]?.exception).toContain("Harbor produced no result");
    expect(progress).toEqual(["gpt-5.6-sol:1/1"]);
  });

  test("accepts an export containing a non-ten task count", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-evaluate-export-test-"));
    const taskRoot = join(root, "expanded", "harbor-task");
    const packageRoot = join(root, "package");
    const taskArchive = join(root, "task-a.tar.gz");
    const exportArchive = join(root, "export.tar.gz");
    await Promise.all([
      mkdir(taskRoot, { recursive: true }),
      mkdir(join(packageRoot, "tasks"), { recursive: true }),
    ]);
    await writeFile(join(taskRoot, "task.toml"), 'schema_version = "1.4"\n');
    await runCommand("tar", ["-czf", taskArchive, "-C", join(root, "expanded"), "harbor-task"]);
    await copyFile(taskArchive, join(packageRoot, "tasks", "task-a.tar.gz"));
    await runCommand("tar", ["-czf", exportArchive, "-C", packageRoot, "tasks"]);
    await writeFile(
      join(root, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "token" } }),
    );

    const results = await runMatrix({
      exportPath: exportArchive,
      jobsDirectory: join(root, "jobs"),
      authPath: join(root, "auth.json"),
      harborPath: "false",
      models: ["gpt-5.6-luna"],
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.model).toBe("gpt-5.6-luna");
    expect(results[0]?.exception).toContain("Harbor produced no result");
  });

  test("rejects ambiguous task inputs", async () => {
    await expect(
      runMatrix({
        exportPath: "export.tar.gz",
        tasksPath: "tasks",
        jobsDirectory: "jobs",
      }),
    ).rejects.toThrow("provide exactly one of exportPath or tasksPath");
  });
});
