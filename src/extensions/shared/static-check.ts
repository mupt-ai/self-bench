import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CheckVerdict {
  ok: boolean;
  errors: { gate: string; message: string }[];
  renderedDirectory?: string;
}

export interface ToolFailure {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError: true;
}

export interface StagedSubmission {
  readonly directory: string;
  readonly definitionJson: string;
  dispose(): void;
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

/** Writes definition.json, test.patch, and gold.patch to a private staging directory. */
export function stageSubmission(
  definition: unknown,
  testPatch: string,
  goldPatch: string,
  prefix = "selfbench-submit-",
): StagedSubmission {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const definitionJson = `${JSON.stringify(definition, null, 2)}\n`;
  writeFileSync(join(directory, "definition.json"), definitionJson);
  writeFileSync(join(directory, "test.patch"), testPatch);
  writeFileSync(join(directory, "gold.patch"), goldPatch);
  return {
    directory,
    definitionJson,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/**
 * Runs the bundled sandbox-check program (schema, policy, paths, audit, dry render) over a staged
 * submission. The rendered tree lands under SELFBENCH_RENDER_OUTPUT (default /work) as rendered/.
 */
export function runStaticCheck(staging: string, extra: readonly string[] = []): CheckVerdict {
  const program = requiredEnvironment("SELFBENCH_CHECK_PROGRAM");
  const result = spawnSync(
    process.execPath,
    [
      program,
      join(staging, "definition.json"),
      join(staging, "test.patch"),
      join(staging, "gold.patch"),
      process.env.SELFBENCH_RENDER_OUTPUT ?? "/work",
      ...extra,
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

export function staticCheckFailure(verdict: CheckVerdict, subject: string): ToolFailure {
  const lines = verdict.errors.map((error) => `- [${error.gate}] ${error.message}`).join("\n");
  const rendered = verdict.renderedDirectory
    ? `\nThe dry-rendered Harbor tree (as far as rendering succeeded) is under ${verdict.renderedDirectory}.`
    : "";
  return failure(
    `The ${subject} failed the static check; nothing was recorded. Fix every item and try again:\n${lines}${rendered}`,
  );
}

export function failure(text: string): ToolFailure {
  return { content: [{ type: "text", text }], details: {}, isError: true };
}
