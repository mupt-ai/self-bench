import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Difficulty } from "../../contracts/index.js";
import { errorMessage } from "../../lib/util.js";
import { auditPatches } from "./audit.js";
import { baseImageProblems } from "./dockerfile.js";
import { assertSafePatchPaths } from "./paths.js";

/**
 * Everything an author writes, in /work/task. The task's identity (repository, base commit,
 * pull request) is the candidate's, and its limits are every task's (render.ts).
 */
export const SUBMISSION_FILES = [
  "instruction.md",
  "Dockerfile",
  "smoke.sh",
  "run-tests.sh",
  "test.patch",
  "gold.patch",
] as const;

export type Submission = Readonly<Record<(typeof SUBMISSION_FILES)[number], string>>;

export interface SubmissionCheck {
  /** What keeps the submission from compiling. */
  readonly errors: readonly string[];
  /** What keeps a compilable submission from being a benchmark (audit.ts). */
  readonly blockers: readonly string[];
  readonly difficulty: Difficulty;
}

/** Reads a submission; a missing file reads as empty, which the check reports. */
export async function readSubmission(directory: string): Promise<Submission> {
  const files = await Promise.all(
    SUBMISSION_FILES.map(
      async (name) =>
        [name, await readFile(join(directory, name), "utf8").catch(() => "")] as const,
    ),
  );
  return Object.fromEntries(files) as Submission;
}

/**
 * Every check that needs neither Docker nor the repository. The author's `verify` runs it in its
 * sandbox, and the trusted compiler runs it again.
 */
export function checkSubmission(submission: Submission, assigned: Difficulty): SubmissionCheck {
  const errors = SUBMISSION_FILES.filter((name) => !submission[name].trim()).map(
    (name) => `${name} is missing or empty`,
  );
  for (const name of ["test.patch", "gold.patch"] as const) {
    const patch = submission[name];
    if (!patch.trim()) continue;
    const problems = malformedPatchProblems(name, patch);
    if (problems.length === 0) {
      try {
        assertSafePatchPaths(patch, name);
      } catch (error) {
        problems.push(errorMessage(error));
      }
    }
    errors.push(...problems);
  }
  if (submission.Dockerfile.trim()) {
    errors.push(...baseImageProblems(submission.Dockerfile));
    if (!submission.Dockerfile.includes("repo.tar.gz")) {
      errors.push("Dockerfile must unpack repo.tar.gz into /app: ADD repo.tar.gz /app/");
    }
  }
  for (const name of ["Dockerfile", "smoke.sh", "run-tests.sh"] as const) {
    if (SECRET_MATERIAL.test(submission[name])) errors.push(`${name} references secret material`);
  }
  if (errors.length > 0) return { errors, blockers: [], difficulty: assigned };
  return { errors, ...auditPatches(submission["gold.patch"], submission["test.patch"], assigned) };
}

const SECRET_MATERIAL =
  /\$\{\{\s*secrets\.|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:GH|GITHUB|NPM|PYPI|AWS|OPENAI|E2B|VERCEL|MODAL)_(?:TOKEN|KEY|SECRET)/i;

/** Text-level problems that make git reject a patch before it even reaches apply --check. */
function malformedPatchProblems(name: string, patch: string): string[] {
  const problems: string[] = [];
  if (!patch.startsWith("diff --git ")) {
    problems.push(`${name} must be a Git patch starting with diff --git`);
  }
  if (patch.includes("\r\n")) {
    problems.push(`${name} has CRLF line endings; write it with LF only`);
  }
  if (!patch.endsWith("\n")) {
    problems.push(`${name} is missing its final newline`);
  }
  return problems;
}
