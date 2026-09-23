import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { E2BCredentials } from "../src/config/index.js";
import { buildSelfBenchE2BTemplate } from "../src/setup/e2b/build.js";

/** Builds Dockerfile.sandbox as an E2B template: bun scripts/build-e2b-template.ts --name NAME[:TAG]. */
const parsed = parseArgs({
  args: process.argv.slice(2),
  options: {
    name: { type: "string" },
    cpus: { type: "string", default: "4" },
    "memory-mib": { type: "string", default: "8192" },
  },
  strict: true,
});
const name = parsed.values.name?.trim();
if (!name) {
  throw new Error("--name is required for scripts/build-e2b-template.ts");
}
const apiKey = process.env.E2B_API_KEY?.trim();
if (!apiKey) {
  throw new Error("E2B_API_KEY is required for scripts/build-e2b-template.ts");
}
const domain = process.env.E2B_DOMAIN?.trim();
const credentials: E2BCredentials = { apiKey, ...(domain ? { domain } : {}) };
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = await buildSelfBenchE2BTemplate({
  name,
  cpuCount: positiveInteger(parsed.values.cpus, "--cpus"),
  memoryMiB: positiveInteger(parsed.values["memory-mib"], "--memory-mib"),
  credentials,
  projectRoot,
  onLog: (message) => console.error(message),
});
console.log(
  JSON.stringify(
    {
      template: result.name,
      templateId: result.templateId,
      buildId: result.buildId,
      configure: `export SELFBENCH_E2B_TEMPLATE=${shellAssignment(result.name)}`,
    },
    null,
    2,
  ),
);

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function shellAssignment(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
