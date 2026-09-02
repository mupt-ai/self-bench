import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outputDirectory = join(root, "dist");

const programs = ["author", "check", "verifier"] as const;

const extensions = ["authoring", "verifier"] as const;

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  ...extensions.map(async (extension) => {
    // pi loads each extension file standalone, so shared modules are bundled in while pi's own
    // API and TypeBox stay external and resolve inside the sandbox exactly as before.
    const result = await Bun.build({
      entrypoints: [join(root, "src/extensions", `${extension}.ts`)],
      outdir: outputDirectory,
      naming: `extension-${extension}.bundle.js`,
      target: "node",
      format: "esm",
      external: ["@earendil-works/pi-coding-agent", "@sinclair/typebox"],
    });
    if (!result.success) {
      throw new AggregateError(result.logs, `failed to bundle ${extension} extension`);
    }
  }),
  ...programs.map(async (program) => {
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
]);
