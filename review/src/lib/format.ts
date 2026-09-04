export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").slice(0, 16);
}

export function keyTail(key: string, segments = 2): string {
  return key.split("/").slice(-segments).join("/");
}

export function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

export function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Sort helper that keeps numbers numeric and strings case-insensitive. */
export function compareValues(left: unknown, right: unknown): number {
  if (left === undefined || left === null) return right === undefined || right === null ? 0 : 1;
  if (right === undefined || right === null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { sensitivity: "base" });
}
