import { resolve } from "node:path";
import { z } from "zod";
import type { CommandResult } from "../../process.js";

export const MINIMUM_CLI_VERSION = [59, 1, 3] as const;
export const VERCEL_CLI_PAGE_SIZE = "100";

export function vcrLoginArgs(teamSlug: string, projectId: string): string[] {
  return [
    "vcr",
    "login",
    "docker",
    "--project",
    projectId,
    "--scope",
    teamSlug,
    "--non-interactive",
  ];
}

export function vcrBuildArgs(input: {
  readonly repository: string;
  readonly tag: string;
  readonly projectRoot: string;
  readonly teamSlug: string;
  readonly projectId: string;
}): string[] {
  return [
    "vcr",
    "build",
    "docker",
    input.projectRoot,
    `${input.repository}:${input.tag}`,
    "--project",
    input.projectId,
    "--platform",
    "linux/amd64",
    "--push",
    "--scope",
    input.teamSlug,
    "--non-interactive",
    "--",
    "--file",
    resolve(input.projectRoot, "Dockerfile.sandbox"),
    "--provenance=false",
  ];
}

export function parseCliVersion(value: string): readonly [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

export function parseLoggedIn(value: string): boolean {
  try {
    const parsed = z
      .object({ loggedIn: z.boolean().optional() })
      .passthrough()
      .parse(JSON.parse(value));
    return parsed.loggedIn ?? true;
  } catch {
    return false;
  }
}

export function parseJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${context} returned invalid JSON`, { cause: error });
  }
}

export function paginationValue(value: string | number | null | undefined): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

export function uniqueById<T extends { readonly id: string }>(values: readonly T[]): readonly T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

export function isNotFound(result: CommandResult): boolean {
  return /(?:not[_ -]?found|does not exist|\b404\b)/i.test(`${result.stdout}\n${result.stderr}`);
}

export function commandFailure(action: string, result: CommandResult): Error {
  const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 1_000);
  return new Error(`${action} failed with exit ${result.exitCode}${detail ? `: ${detail}` : ""}`);
}
