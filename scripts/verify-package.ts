import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const options = process.argv.slice(2);
const dockerBuild = options.length === 1 && options[0] === "--docker-build";
if (options.length > 0 && !dockerBuild) {
  throw new Error(`unknown verify-package argument: ${options.join(" ")}`);
}
const root = resolve(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "self-bench-package-"));

async function run(command: string, args: string[], cwd = root): Promise<string> {
  const child = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${stderr || stdout}`);
  }
  return stdout;
}

try {
  await run("bun", ["pm", "pack", "--destination", temporary]);
  const tarballs = (await Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: temporary }))).map(
    (name) => join(temporary, name),
  );
  const tarball =
    tarballs[0] ??
    (() => {
      throw new Error("bun pm pack did not create a tarball");
    })();
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
    bin: Record<string, string>;
  };
  const installRoot = join(temporary, "install");
  await run("mkdir", ["-p", installRoot]);
  await run("bun", ["init", "--yes"], installRoot);
  await run("bun", ["add", "--no-save", tarball], installRoot);
  const executable = join(installRoot, "node_modules", ".bin", "self-bench");
  const help = await run(executable, ["--help"], installRoot);
  if (!help.includes("self-bench up")) {
    throw new Error("installed self-bench did not print the expected CLI help");
  }
  const installedRoot = join(installRoot, "node_modules", packageJson.name);
  for (const [name, target] of Object.entries(packageJson.bin)) {
    await readFile(join(installedRoot, target));
    await readFile(join(installRoot, "node_modules", ".bin", name));
  }
  for (const asset of [
    "dist/api-main.js",
    "dist/temporal/worker-main.js",
    "dist/sandbox-author.bundle.js",
    "dist/sandbox-environment.bundle.js",
    "dist/sandbox-review.bundle.js",
    "dist/sandbox-repair.bundle.js",
    "dist/sandbox-validation-repair.bundle.js",
    "dist/review/index.html",
  ]) {
    await readFile(join(installedRoot, asset));
  }
  for (const asset of [
    ".dockerignore",
    "compose.yaml",
    "Dockerfile",
    "Dockerfile.sandbox",
    "review/index.html",
    "review/src/App.tsx",
    "review/vite.config.ts",
    "src/extensions/authoring.ts",
    "src/extensions/environment.ts",
    "src/skills/selfbench/SKILL.md",
  ]) {
    await readFile(join(installedRoot, asset));
  }
  const installedPackage = JSON.parse(
    await readFile(join(installedRoot, "package.json"), "utf8"),
  ) as { name: string; version: string };
  if (
    installedPackage.name !== packageJson.name ||
    installedPackage.version !== packageJson.version
  ) {
    throw new Error("installed package metadata does not match the workspace package");
  }
  if (dockerBuild) {
    await run(
      "docker",
      ["build", "--target", "build", "--file", join(installedRoot, "Dockerfile"), installedRoot],
      installedRoot,
    );
  }
  console.log(`verified ${installedPackage.name}@${installedPackage.version}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
