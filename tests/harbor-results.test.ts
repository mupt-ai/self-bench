import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveIncompleteHarborJob,
  harborInfrastructureError,
  readHarborJobResult,
  tryReadHarborJobResult,
} from "../src/harbor-results.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Harbor result loading", () => {
  test("loads the current per-trial result layout", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-harbor-result-"));
    roots.push(root);
    await mkdir(join(root, "job", "task__trial"), { recursive: true });
    await writeFile(join(root, "job", "result.json"), JSON.stringify({ stats: {} }));
    await mkdir(join(root, "job", "task__trial", "verifier"));
    await Promise.all([
      writeFile(
        join(root, "job", "task__trial", "result.json"),
        JSON.stringify({ verifier_result: { rewards: { reward: 1 } } }),
      ),
      writeFile(
        join(root, "job", "task__trial", "verifier", "test-stdout.txt"),
        "combined output\n",
      ),
      writeFile(join(root, "job", "task__trial", "verifier", "test-stderr.txt"), "stderr output\n"),
    ]);

    const result = await readHarborJobResult(root, "job");
    expect(result.job).toEqual({ stats: {} });
    expect(result.trial).toEqual({ verifier_result: { rewards: { reward: 1 } } });
    expect(result.verifier).toEqual({
      combined: "combined output\n",
      stderr: "stderr output\n",
    });
  });

  test("preserves aggregate fallback when stale local trial directories coexist", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-harbor-result-"));
    roots.push(root);
    await Promise.all([
      mkdir(join(root, "job", "old-trial"), { recursive: true }),
      mkdir(join(root, "job", "new-trial"), { recursive: true }),
    ]);
    const aggregate = { verifier_result: { rewards: { reward: 1 } } };
    await Promise.all([
      writeFile(join(root, "job", "result.json"), JSON.stringify({ trial_results: [aggregate] })),
      writeFile(join(root, "job", "old-trial", "result.json"), JSON.stringify({ stale: true })),
      writeFile(join(root, "job", "new-trial", "result.json"), JSON.stringify({ stale: false })),
    ]);

    expect((await readHarborJobResult(root, "job")).trial).toEqual(aggregate);
  });

  test("separates environment infrastructure from task build failures", () => {
    expect(
      harborInfrastructureError({
        exception_info: {
          exception_type: "RuntimeError",
          exception_message: "Docker compose failed: unknown flag: --project-name",
        },
      }),
    ).toContain("unknown flag");
    expect(
      harborInfrastructureError({
        exception_info: {
          exception_type: "RuntimeError",
          exception_message: "Dockerfile command uv sync exited 1",
        },
      }),
    ).toBeUndefined();
    expect(
      harborInfrastructureError({
        exception_info: {
          exception_message: "all predefined address pools have been fully subnetted",
        },
      }),
    ).toContain("address pools");
    expect(
      harborInfrastructureError({
        exception_info: {
          exception_type: "AuthError",
          exception_message: "Token missing. Could not authenticate client.",
        },
      }),
    ).toContain("Token missing");
    expect(
      harborInfrastructureError({
        exception_info: {
          exception_type: "RemoteError",
          exception_message:
            "Image build for im-n0GpgX8tB0TtLhGeEh0a2t failed. See build logs for more details.",
        },
      }),
    ).toContain("Image build");
  });

  test("archives an interrupted job before retrying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-harbor-result-"));
    roots.push(root);
    await mkdir(join(root, "job"));
    await writeFile(
      join(root, "job", "result.json"),
      JSON.stringify({ finished_at: null, stats: { n_running_trials: 1 } }),
    );

    expect(await tryReadHarborJobResult(root, "job")).toBeUndefined();
    const archived = await archiveIncompleteHarborJob(root, "job");
    expect(archived).toContain("job.incomplete-");
    expect(await tryReadHarborJobResult(root, "job")).toBeUndefined();
  });
});
