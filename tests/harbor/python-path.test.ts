import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { harborPythonPath } from "../../src/harnesses/harbor/command.js";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test("the sources find Harbor's adapters beside the module", () => {
  expect(harborPythonPath()).toBe(`${resolve("src/harnesses/harbor/runtime")}/`);
});

test("a bundled maintenance program finds the adapters the server build packaged", async () => {
  // Real path: macOS hands out /var/folders, which the bundle sees as /private/var/folders.
  root = await realpath(await mkdtemp(join(tmpdir(), "selfbench-python-path-")));
  await writeFile(join(root, "package.json"), "{}");
  const runtime = join(root, "dist/harnesses/harbor/runtime");
  await mkdir(runtime, { recursive: true });
  const entry = join(root, "entry.ts");
  await writeFile(
    entry,
    `import { harborPythonPath } from ${JSON.stringify(resolve("src/harnesses/harbor/command.ts"))};\nconsole.log(harborPythonPath());\n`,
  );
  // As scripts/build-maintenance.ts bundles them.
  const built = await Bun.build({
    entrypoints: [entry],
    outdir: join(root, "dist/maintenance"),
    target: "node",
    format: "esm",
    packages: "external",
  });
  expect(built.success).toBe(true);
  const run = Bun.spawnSync(["node", join(root, "dist/maintenance/entry.js")]);
  expect(run.stdout.toString().trim()).toBe(`${runtime}/`);
});
