import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMatrix, summarizeResult } from "../src/evaluate.js";

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
    await expect(
      runMatrix({
        tasksPath: tasks,
        jobsDirectory: join(root, "jobs"),
        authPath: join(root, "auth.json"),
        harborPath: "false",
      }),
    ).rejects.toThrow("Harbor produced no result for task-a/gpt-5.6-");
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
