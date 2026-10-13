import { record } from "../evaluation/output.js";

export type Generation = Record<string, unknown> & { id: string };
export type Pause = () => Promise<void>;
export const billingPause: Pause = () => new Promise((resolve) => setTimeout(resolve, 5000));
const charge = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** BYOK upstream inference is separate from the gateway fee; non-BYOK total already includes it. */
export function generationCharge(data: Record<string, unknown>): number | undefined {
  const total = charge(data.total_cost);
  const upstream = data.is_byok === true ? charge(data.upstream_inference_cost) : 0;
  return total === undefined || upstream === undefined ? undefined : total + upstream;
}

export function generationLookup(base: string, key: string, fetcher: typeof fetch, pause: Pause) {
  return async (id: string): Promise<Generation | undefined> => {
    try {
      for (let attempt = 0; attempt < 7; attempt++) {
        const response = await fetcher(`${base}/generation?id=${encodeURIComponent(id)}`, {
          redirect: "error",
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const data = record(record(await response.json()).data);
          if (data.id !== undefined && data.id !== id) return undefined;
          return { ...data, id };
        }
        if (response.status !== 404) return undefined;
        if (attempt < 6) await pause();
      }
    } catch {
      // Never log authenticated provider response bodies.
    }
    return undefined;
  };
}

export async function lookupGenerations(
  ids: string[],
  lookup: (id: string) => Promise<Generation | undefined>,
) {
  const rows: Generation[] = [];
  for (let index = 0; index < ids.length; index += 10) {
    const batch = await Promise.all(ids.slice(index, index + 10).map(lookup));
    for (const row of batch) {
      if (!row) return undefined;
      rows.push(row);
    }
  }
  return rows;
}
