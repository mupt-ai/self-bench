import { startApi } from "./api.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const stop = await startApi(config);
console.log(`SelfBench API listening on http://${config.apiHost}:${config.apiPort}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop().finally(() => process.exit(0));
  });
}
