export interface JsonRecord {
  readonly [key: string]: unknown;
}

export function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function nonnegativeNumber(value: unknown): number {
  return typeof value === "number" && value >= 0 ? value : 0;
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
