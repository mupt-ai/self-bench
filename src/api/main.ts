import { loadConfig } from "../contracts/config/index.js";
import { keepGatewaysFresh } from "../gateways/refresh.js";
import { closeAnalytics, initAnalytics } from "../lib/telemetry/posthog.js";
import { closeSentry, initSentry } from "../lib/telemetry/sentry.js";
import { loadAuthConfig } from "./auth/config.js";
import { startApi } from "./server.js";

initSentry("api");
initAnalytics();
const config = loadConfig();
const auth = loadAuthConfig();
const gatewayCatalogs = keepGatewaysFresh();
await gatewayCatalogs.ready;
const stop = await startApi(config, auth ? { auth } : {});
console.log(`SelfBench API listening on http://${config.apiHost}:${config.apiPort}`);
if (auth) console.log(`GitHub sign-in enabled; public URL ${auth.publicUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    gatewayCatalogs.stop();
    void stop()
      .catch((error) => console.error("SelfBench API did not stop cleanly", error))
      .then(() => Promise.allSettled([closeAnalytics(), closeSentry()]))
      .finally(() => process.exit(0));
  });
}
