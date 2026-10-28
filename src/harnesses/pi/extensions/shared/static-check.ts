import { spawnSync } from "node:child_process";

interface CheckVerdict {
  ok: boolean;
  errors: string[];
}

export interface ToolFailure {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError: true;
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

/**
 * Runs the bundled sandbox-check program over the submission in `directory`: the files, their
 * static checks and audit, and both patches applied to the candidate's base commit.
 */
export function runStaticCheck(directory: string): CheckVerdict {
  const result = spawnSync(
    process.execPath,
    [
      requiredEnvironment("SELFBENCH_CHECK_PROGRAM"),
      directory,
      requiredEnvironment("SELFBENCH_DIFFICULTY"),
      process.env.SELFBENCH_REPO_DIRECTORY ?? "/work/repo",
      requiredEnvironment("SELFBENCH_BASE_COMMIT"),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `static check program failed: ${(result.stderr || result.stdout).slice(-4_000)}`,
    );
  }
  return JSON.parse(result.stdout) as CheckVerdict;
}

export function staticCheckFailure(verdict: CheckVerdict): ToolFailure {
  const lines = verdict.errors.map((error) => `- ${error}`).join("\n");
  const text = `The task failed the static check; nothing was recorded. Fix every item and try again:\n${lines}`;
  return { content: [{ type: "text", text }], details: {}, isError: true };
}
