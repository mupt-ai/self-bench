import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./process.js";
import { patchPaths } from "./repair.js";

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
    for (const [label, patch] of [
      ["test.patch", input.testPatch],
      ["gold.patch", input.goldPatch],
    ] as const) {
      const ignored = await exportIgnoredPaths(worktree, patchPaths(patch));
      if (ignored.length > 0) {
        errors.push({
          gate: "patch",
          message: `${label} touches ${ignored.join(", ")}, which the repository marks export-ignore in .gitattributes; the snapshot the solver and the verifier receive cannot contain such paths. Keep tests and changes outside export-ignored paths, or decline the task if the change lives only there.`,
        });
      }
    }
    if (errors.length > 0) {
      return errors;
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

/**
 * Patch paths that `git archive` would drop from the repository snapshot: the path itself or any
 * ancestor directory carries the export-ignore attribute (directories are queried with a trailing
 * slash, the form git archive uses).
 */
export async function exportIgnoredPaths(
  worktree: string,
  paths: readonly string[],
): Promise<string[]> {
  const candidates = new Map<string, string>();
  for (const path of paths) {
    const segments = path.split("/").filter(Boolean);
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const prefix = segments.slice(0, depth).join("/");
      candidates.set(prefix, path);
      if (depth < segments.length) {
        candidates.set(`${prefix}/`, path);
      }
    }
  }
  if (candidates.size === 0) {
    return [];
  }
  const result = await runCommand(
    "git",
    ["-C", worktree, "check-attr", "-z", "export-ignore", "--", ...candidates.keys()],
    { allowFailure: true },
  );
  if (result.exitCode !== 0) {
    return [];
  }
  const fields = result.stdout.split("\0");
  const ignored = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [queried, , value] = [fields[index], fields[index + 1], fields[index + 2]];
    if (value === "set" && queried !== undefined) {
      const owner = candidates.get(queried);
      if (owner) {
        ignored.add(owner);
      }
    }
  }
  return [...ignored].sort();
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
