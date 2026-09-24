import { loadEnvFiles } from "../lib/env-file.js";

// Cloud Run entrypoint. The API's settings live in the same Secret Manager env-file bundles the
// VM's Compose release reads; Cloud Run mounts pinned versions as files, listed in
// SELFBENCH_ENV_FILES in precedence order. Values set on the service itself win.
loadEnvFiles((process.env.SELFBENCH_ENV_FILES ?? "").split(",").filter(Boolean), process.env);
await import("./main.js");
