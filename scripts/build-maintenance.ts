import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outdir = join(root, "dist/maintenance");
await mkdir(outdir, { recursive: true });
const result = await Bun.build({
  entrypoints: [
    "recompute-cost",
    "repair-cost-coverage",
    "reprice-vendor-rates",
    "reprice-dari-router",
    "reprice-openrouter",
    "backfill-timeouts",
    "backfill-execution-bundles",
    "compact-task-bundles",
    "reverify-task-images",
    "records-migration",
  ].map((name) => join(root, "maintenance/bin", `${name}.ts`)),
  // Pinned, or Bun may pick a higher common directory and nest the outputs under it.
  root: join(root, "maintenance/bin"),
  outdir,
  target: "node",
  format: "esm",
  packages: "external",
});
if (!result.success) throw new AggregateError(result.logs, "failed to bundle maintenance programs");
