import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outdir = join(root, "dist/maintenance");
await mkdir(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: [
    "recompute-cost",
    "reprice-vendor-rates",
    "backfill-agent-timeouts",
    "records-migration",
  ].map((name) => join(root, "maintenance/bin", `${name}.ts`)),
  outdir,
  target: "node",
  format: "esm",
  packages: "external",
});
if (!result.success) throw new AggregateError(result.logs, "failed to bundle maintenance programs");
