import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withExecutionEnvironment } from "../../../src/execution-environment.js";
import {
  extractModalImageId,
  HARBOR_MODAL_APP,
  modalBuildLogTail,
} from "../../../src/generation/verify/modal-build-log.js";

const failure =
  "Harbor nop infrastructure failure for task: ImageBuildError: image build for im-Abc123xyz failed";

describe("Modal build log tail", () => {
  test("uses the current run's sandbox credentials when collecting build logs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "selfbench-modal-log-"));
    try {
      await writeFile(
        join(directory, "modal"),
        `#!/bin/sh
test "$MODAL_TOKEN_ID" = "run-token-id" || exit 1
test "$MODAL_TOKEN_SECRET" = "run-token-secret" || exit 1
test -z "$E2B_API_KEY" || exit 1
printf 'Building image im-Abc123xyz\\nThe lockfile needs to be updated\\n'
`,
        { mode: 0o700 },
      );
      const log = await withExecutionEnvironment(
        {
          ...process.env,
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          MODAL_TOKEN_ID: "run-token-id",
          MODAL_TOKEN_SECRET: "run-token-secret",
          E2B_API_KEY: "unrelated-key",
        },
        () => modalBuildLogTail(failure),
      );
      expect(log).toContain("The lockfile needs to be updated");
      expect(log).not.toContain("run-token-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("extracts the image id from an ImageBuildError message", () => {
    expect(extractModalImageId(failure)).toBe("im-Abc123xyz");
    expect(extractModalImageId("cannot connect to the docker daemon")).toBeUndefined();
  });

  test("fetches recent Harbor app logs and keeps the section around the image", async () => {
    const calls: string[][] = [];
    const log = await modalBuildLogTail(failure, async (command, args) => {
      calls.push([command, ...args]);
      return {
        exitCode: 0,
        stdout: [
          "old unrelated line",
          "Building image im-Abc123xyz",
          "Step 3/9 RUN apt-get install -y libfoo",
          "E: Unable to locate package libfoo",
          "Image build for im-Abc123xyz failed",
        ].join("\n"),
        stderr: "",
      };
    });

    expect(calls).toEqual([["modal", "app", "logs", HARBOR_MODAL_APP, "--tail", "400"]]);
    expect(log).toContain("Modal build log for im-Abc123xyz");
    expect(log).toContain("E: Unable to locate package libfoo");
  });

  test("says when the CLI cannot fetch the log instead of returning the bare id", async () => {
    const failed = await modalBuildLogTail(failure, async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "Error: no token found",
    }));
    expect(failed).toBe(
      "Modal build log for im-Abc123xyz could not be fetched (Error: no token found); open the image in the Modal dashboard for the full build output.",
    );
    const thrown = await modalBuildLogTail(failure, async () => {
      throw new Error("spawn modal ENOENT");
    });
    expect(thrown).toContain("could not be fetched (spawn modal ENOENT)");
    expect(
      await modalBuildLogTail("docker daemon down", async () => ({
        exitCode: 0,
        stdout: "x",
        stderr: "",
      })),
    ).toBeUndefined();
  });

  test("caps the log tail at about 4 KB", async () => {
    const log = await modalBuildLogTail(failure, async () => ({
      exitCode: 0,
      stdout: `im-Abc123xyz\n${"x".repeat(10_000)}`,
      stderr: "",
    }));
    expect(log?.length ?? 0).toBeLessThan(4_500);
    expect(log).toContain("[truncated");
  });
});
