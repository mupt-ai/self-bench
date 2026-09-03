import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./process.js";

export interface PatchApplyCheckInput {
  readonly repository: string;
  /** Commit or ref of the clean base tree inside `repository`. */
  readonly base: string;
  readonly testPatch: string;
  readonly goldPatch: string;
}

export interface PatchApplyError {
  readonly gate: "patch";
  readonly message: string;
}

/**
 * Proves both patches apply before any image is built: test.patch against the clean base tree,
 * gold.patch against the clean base tree, and gold.patch on top of test.patch (the oracle order).
 * Uses a detached temporary worktree so the agent's working-tree edits never interfere.
 */
export async function patchApplyCheck(input: PatchApplyCheckInput): Promise<PatchApplyError[]> {
  const scratch = await mkdtemp(join(tmpdir(), "selfbench-patch-check-"));
  const worktree = join(scratch, "base");
  const testPatch = join(scratch, "test.patch");
  const goldPatch = join(scratch, "gold.patch");
  const errors: PatchApplyError[] = [];
  try {
    await Promise.all([
      writeFile(testPatch, input.testPatch),
      writeFile(goldPatch, input.goldPatch),
    ]);
    const added = await runCommand(
      "git",
      ["-C", input.repository, "worktree", "add", "--detach", worktree, input.base],
      { allowFailure: true },
    );
    if (added.exitCode !== 0) {
      return [
        {
          gate: "patch",
          message: `base tree ${input.base} is not available in ${input.repository}: ${added.stderr.trim()}`,
        },
      ];
    }
    const check = async (patch: string, label: string, context: string): Promise<boolean> => {
      const result = await runCommand(
        "git",
        ["-C", worktree, "apply", "--check", "--binary", "--whitespace=nowarn", patch],
        { allowFailure: true },
      );
      if (result.exitCode !== 0) {
        errors.push({
          gate: "patch",
          message: `${label} does not apply ${context}: ${gitMessage(result.stderr)}`,
        });
        return false;
      }
      return true;
    };
    const testApplies = await check(testPatch, "test.patch", "to the clean base tree");
    const goldApplies = await check(goldPatch, "gold.patch", "to the clean base tree");
    if (testApplies && goldApplies) {
      await runCommand("git", [
        "-C",
        worktree,
        "apply",
        "--binary",
        "--whitespace=nowarn",
        testPatch,
      ]);
      await check(goldPatch, "gold.patch", "on top of test.patch (the oracle order)");
    }
    return errors;
  } finally {
    await runCommand("git", ["-C", input.repository, "worktree", "remove", "--force", worktree], {
      allowFailure: true,
    }).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Text-level problems that make git reject a patch before it even reaches apply --check. */
export function malformedPatchProblems(patch: string, label: string): string[] {
  const problems: string[] = [];
  if (!patch.startsWith("diff --git ")) {
    problems.push(`${label} must be a Git patch starting with diff --git`);
  }
  if (patch.includes("\r\n")) {
    problems.push(`${label} has CRLF line endings; write it with LF only`);
  }
  if (patch.length > 0 && !patch.endsWith("\n")) {
    problems.push(`${label} is missing its final newline`);
  }
  return problems;
}

function gitMessage(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-6).join("; ") || "git apply --check failed";
}
