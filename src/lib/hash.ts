import { createHash } from "node:crypto";

export function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** JSON with object keys sorted and undefined values dropped, so equal data hashes equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => (left < right ? -1 : 1)))
      : item,
  );
}
