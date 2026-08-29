import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outputDirectory = join(root, "dist");

const programs = ["author", "environment", "review", "repair", "validation-repair"] as const;

await mkdir(outputDirectory, { recursive: true });
await Promise.all(
  programs.map(async (program) => {
    const result = await Bun.build({
      entrypoints: [join(root, "src/sandbox/programs", `${program}.ts`)],
      outdir: outputDirectory,
      naming: `sandbox-${program}.bundle.js`,
      target: "node",
    });
    if (!result.success) {
      throw new AggregateError(result.logs, `failed to bundle sandbox ${program} program`);
    }
  }),
);
