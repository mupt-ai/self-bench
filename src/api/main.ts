import { loadConfig } from "../contracts/config/index.js";
import { keepOpenRouterRatesFresh } from "../lib/openrouter-rates.js";
import { closeAnalytics, initAnalytics } from "../lib/telemetry/posthog.js";
import { closeSentry, initSentry } from "../lib/telemetry/sentry.js";
import { loadAuthConfig } from "./auth/config.js";
import { startApi } from "./server.js";

initSentry("api");
initAnalytics();
const config = loadConfig();
const auth = loadAuthConfig();
const openRouterRates = keepOpenRouterRatesFresh();
await openRouterRates.ready;
const stop = await startApi(config, auth ? { auth } : {});
console.log(`SelfBench API listening on http://${config.apiHost}:${config.apiPort}`);
if (auth) console.log(`GitHub sign-in enabled; public URL ${auth.publicUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    openRouterRates.stop();
    void stop()
      .then(() => Promise.allSettled([closeAnalytics(), closeSentry()]))
      .finally(() => process.exit(0));
  });
}
