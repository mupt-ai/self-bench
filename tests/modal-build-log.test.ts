import { describe, expect, test } from "bun:test";
import {
  extractModalImageId,
  HARBOR_MODAL_APP,
  modalBuildLogTail,
} from "../src/temporal/activities/modal-build-log.js";

const failure =
  "Harbor nop infrastructure failure for task: ImageBuildError: image build for im-Abc123xyz failed";

describe("Modal build log tail", () => {
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
