import { type GatewayId, gatewayIds, gateways, setGatewayListing } from "./index.js";

const REFRESH_MS = 60 * 60 * 1000;

/** Loads a gateway's models and list prices; a failed or empty load keeps the last good one. */
export async function refreshGateway(
  gateway: GatewayId,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const { label, modelsUrl, parse } = gateways[gateway];
  const response = await fetcher(modelsUrl, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${label} models returned ${response.status}`);
  const listing = parse(await response.json(), new Date().toISOString().slice(0, 10));
  if (!listing.rates.size) throw new Error(`${label} returned no prices`);
  setGatewayListing(gateway, listing);
}

/**
 * Loads every gateway now and hourly. Each fails on its own: the failure is logged and that
 * gateway's last good listing stays in use.
 */
export function keepGatewaysFresh(): { ready: Promise<void>; stop(): void } {
  const refresh = async () => {
    await Promise.all(
      gatewayIds.map((gateway) =>
        refreshGateway(gateway).catch((error: unknown) =>
          console.warn(
            `${gateways[gateway].label} catalog refresh failed; keeping the current catalog`,
            error,
          ),
        ),
      ),
    );
  };
  const timer = setInterval(refresh, REFRESH_MS);
  timer.unref();
  return { ready: refresh(), stop: () => clearInterval(timer) };
}
