import { copyFile, cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outputDirectory = join(root, "dist");

const programs = ["check", "verifier", "compiler", "task-operation", "job"] as const;

const extensions = ["authoring", "reviewer"] as const;

await mkdir(outputDirectory, { recursive: true });
await mkdir(join(outputDirectory, "harnesses/harbor/runtime"), { recursive: true });
await copyFile(
  join(root, "src/harnesses/harbor/runtime/harbor_gateway.py"),
  join(outputDirectory, "harnesses/harbor/runtime/harbor_gateway.py"),
);
await Promise.all([
  ...extensions.map(async (extension) => {
    // pi loads each extension file standalone, so shared modules are bundled in while pi's own
    // API and TypeBox stay external and resolve inside the sandbox exactly as before.
    const result = await Bun.build({
      entrypoints: [join(root, "src/harnesses/pi/extensions", `${extension}.ts`)],
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

await Promise.all(
  ["generation/task/runtime", "runtime"].map((path) =>
    cp(join(root, "src/generation/task/runtime"), join(outputDirectory, path), {
      recursive: true,
    }),
  ),
);
await cp(
  join(root, "src/generation/pipeline/prompts"),
  join(outputDirectory, "generation/pipeline/prompts"),
  {
    recursive: true,
  },
);
