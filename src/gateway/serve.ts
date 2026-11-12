import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database } from "../db/client.js";
import { validateEndpoint } from "../db/credential-endpoints.js";
import type { Vault } from "../db/vault.js";
import { gatewayModelPrice, listedModelConfig, servedModelCost } from "../gateways/catalog.js";
import { platformModelKey } from "../generation/billing/managed.js";
import { reportError } from "../lib/telemetry/sentry.js";
import { gatewayRoute } from "./mount.js";
import { withManagedModel } from "./platform.js";
import { createGatewayUsageStore } from "./usage-store.js";

/**
 * The model gateway trials call with a trial key, over the org's own keys in the vault and the
 * platform's OpenRouter key for managed model access. Resolves true when it answered the request.
 * The gateway service serves it (gateway/main.ts); so does the API, for a local stack and for
 * trials whose sandboxes reach the API's host without a load balancer in front.
 */
export function selfBenchGateway(
  db: Database,
  vault: Vault,
  secret: string,
  env: NodeJS.ProcessEnv = process.env,
): (request: IncomingMessage, url: URL, response: ServerResponse) => Promise<boolean> {
  const usage = createGatewayUsageStore(db);
  return gatewayRoute({
    secret,
    credentials: withManagedModel(vault.credentials, platformModelKey(env)),
    modelConfig: listedModelConfig,
    modelPrice: gatewayModelPrice,
    servedModelCost,
    endpoint: (endpoint) => validateEndpoint(endpoint, env),
    recordUsage: (entry) => {
      usage.record(entry).catch((error) => reportError(error, { tags: { route: "gateway" } }));
    },
    captureError: (error) => reportError(error, { tags: { route: "gateway" } }),
  });
}
