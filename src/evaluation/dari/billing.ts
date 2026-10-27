import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { record } from "../output.js";

export const DARI_BILLING = "solver/dari-billing.jsonl";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/**
 * The sum of the prices Dari returned. A request without one (cut off by the agent's time limit,
 * or refused before it was billed) adds nothing; invalid structure or no requests prove no bill.
 */
export function responseCost(text: string): number | undefined {
  const requests = new Map<number, number | null>();
  const ids = new Map<string, number>();
  const unpriced = new Set<number>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(line));
    } catch {
      return undefined;
    }
    const index = event.index;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 1) return undefined;
    if (event.type === "request") {
      if (requests.has(index) || requests.size >= 100_000) return undefined;
      requests.set(index, null);
    } else if (event.type === "cost") {
      const cost = event.cost;
      if (
        !requests.has(index) ||
        (event.requestId !== null &&
          (typeof event.requestId !== "string" || !UUID.test(event.requestId)))
      )
        return undefined;
      if (typeof event.requestId === "string") {
        const owner = ids.get(event.requestId);
        if (owner !== undefined && owner !== index) return undefined;
        ids.set(event.requestId, index);
      }
      const previous = requests.get(index);
      if (
        typeof cost !== "number" ||
        !Number.isFinite(cost) ||
        cost < 0 ||
        event.requestId === null ||
        (previous !== null && previous !== cost)
      )
        unpriced.add(index);
      // An invalid frame permanently invalidates this request, not unrelated priced requests.
      requests.set(index, unpriced.has(index) ? null : (cost as number));
    } else return undefined;
  }
  if (!requests.size) return undefined;
  const total = [...requests.values()].reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
  return Number.isFinite(total) ? total : undefined;
}

/** Read the compact bill directly, independent of collectOutput's shared transcript budget. */
export async function retainDariBilling(root: string, files: Map<string, string>): Promise<void> {
  const trials = await readdir(join(root, "solver"), { withFileTypes: true }).catch(() => []);
  for (const trial of trials) {
    const agent = join(root, "solver", trial.name, "agent");
    if (!trial.isDirectory() || !(await lstat(agent).catch(() => undefined))?.isDirectory())
      continue;
    const file = await open(
      join(agent, "dari-billing.jsonl"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).catch(() => undefined);
    if (!file) continue;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) continue;
      // Invalid or oversized evidence blocks fallback to transcript-derived prices.
      const text = stat.size <= 16 * 1024 * 1024 ? await file.readFile("utf8") : "invalid";
      files.set(DARI_BILLING, files.has(DARI_BILLING) ? "invalid" : text);
    } finally {
      await file.close();
    }
  }
}
