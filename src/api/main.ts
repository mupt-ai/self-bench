import { loadAuthConfig } from "../auth/config.js";
import { loadConfig } from "../config/index.js";
import { startApi } from "./server.js";

const config = loadConfig();
const auth = loadAuthConfig();
const stop = await startApi(config, auth ? { auth } : {});
console.log(`SelfBench API listening on http://${config.apiHost}:${config.apiPort}`);
if (auth) console.log(`GitHub sign-in enabled; public URL ${auth.publicUrl}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop().finally(() => process.exit(0));
  });
}
