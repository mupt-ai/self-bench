import { type GatewayId, gatewayIds, gateways, listedModels, setGatewayListing } from "./index.js";

const REFRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;

/**
 * Loads a gateway's models and list prices. A failed load, or one with no prices or no models a
 * harness can drive (as after a change to the response's shape), keeps the last good one.
 */
export async function refreshGateway(
  gateway: GatewayId,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const { label, modelsUrl, parse } = gateways[gateway];
  const response = await fetcher(modelsUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${label} models returned ${response.status}`);
  const listing = parse(await response.json(), new Date().toISOString().slice(0, 10));
  if (!listing.rates.size) throw new Error(`${label} returned no prices`);
  if (!listing.models.length) throw new Error(`${label} returned no models agents can drive`);
  setGatewayListing(gateway, listing);
}

/**
 * Loads every gateway now and hourly. Each fails on its own: the failure is logged and that
 * gateway's last good listing stays in use. A gateway that has never loaded offers no models, so
 * it retries every minute until it loads rather than waiting for the next hourly refresh.
 */
export function keepGatewaysFresh(): { ready: Promise<void>; stop(): void } {
  const retries = new Map<GatewayId, ReturnType<typeof setTimeout>>();
  let stopped = false;
  const load = (gateway: GatewayId): Promise<void> =>
    refreshGateway(gateway).catch((error: unknown) => {
      console.warn(
        `${gateways[gateway].label} catalog refresh failed; keeping the current catalog`,
        error,
      );
      if (stopped || retries.has(gateway) || listedModels(gateway).length) return;
      const retry = setTimeout(() => {
        retries.delete(gateway);
        void load(gateway);
      }, RETRY_MS);
      retry.unref();
      retries.set(gateway, retry);
    });
  const refresh = async () => {
    await Promise.all(gatewayIds.map(load));
  };
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref();
  return {
    ready: refresh(),
    stop: () => {
      stopped = true;
      clearInterval(timer);
      for (const retry of retries.values()) clearTimeout(retry);
      retries.clear();
    },
  };
}
