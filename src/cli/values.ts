import type { PolledRunStatus } from "../run-wait.js";

export function requiredArgument(args: string[], label: string): string {
  return args[0] ?? fail(`${label} is required`);
}

export function asPolledRunStatus(value: Record<string, unknown>): PolledRunStatus {
  if (typeof value.phase !== "string") {
    throw new Error("SelfBench status response is missing its phase");
  }
  return { ...value, phase: value.phase };
}

export function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export function nonnegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return parsed;
}

export function defaultRunId(): string {
  return `sb-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}

export function fail(message: string): never {
  throw new Error(message);
}
