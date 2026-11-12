import { createServer } from "node:http";
import { clientWentAway, sendApiError, sendJson } from "../api/http.js";
import { openDatabase } from "../db/client.js";
import { createVault } from "../db/vault.js";
import { keepGatewaysFresh } from "../gateways/catalog.js";
import { closeSentry, initSentry, reportError } from "../lib/telemetry/sentry.js";
import { selfBenchGateway } from "./serve.js";

/**
 * The model gateway on its own, apart from the API: every trial's model calls are long streams
 * of large requests, and served from the API they took the site's CPU whenever a batch ran. The
 * load balancer sends the gateway's path here; the API migrates the database, so this only
 * reads credentials and records usage.
 */
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required by the model gateway`);
  return value;
};

initSentry("gateway");
const secret = required("SELFBENCH_SANDBOX_SECRET");
const database = await openDatabase(required("SELFBENCH_DATABASE_URL"), { light: true });
const vault = createVault(database.db, required("SELFBENCH_EVAL_CREDENTIAL_KEY"));
const catalogs = keepGatewaysFresh();
await catalogs.ready;
const gateway = selfBenchGateway(database.db, vault, secret);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/healthz") {
      sendJson(response, 200, { ok: true });
      return;
    }
    if (await gateway(request, url, response)) return;
    sendJson(response, 404, { error: "not found" });
  } catch (error) {
    if (response.headersSent) {
      if (!clientWentAway(error, true)) reportError(error);
      response.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    sendApiError(response, error);
  }
});
const host = process.env.SELFBENCH_API_HOST ?? "0.0.0.0";
const port = Number(process.env.SELFBENCH_API_PORT ?? 8080);
server.listen(port, host, () =>
  console.log(`SelfBench gateway listening on http://${host}:${port}`),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    catalogs.stop();
    server.close();
    void database
      .close()
      .catch((error) => console.error("SelfBench gateway did not stop cleanly", error))
      .then(() => closeSentry())
      .finally(() => process.exit(0));
  });
}
