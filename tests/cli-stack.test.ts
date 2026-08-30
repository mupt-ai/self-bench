import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SelfBench CLI stack", () => {
  test("setup vercel fails before external work when no interactive terminal is attached", async () => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "setup", "vercel", "--verbose"], {
      cwd: join(import.meta.dir, ".."),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("requires an interactive terminal");
    expect(stderr).toContain("VERCEL_TOKEN");
  });
  test("up translates backend flags into stack configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-cli-up-"));
    roots.push(root);
    const binaryDirectory = join(root, "bin");
    const calls = join(root, "docker-calls");
    const modalConfig = join(root, "modal.toml");
    await mkdir(binaryDirectory);
    await writeFile(modalConfig, "[profile]\n");
    const docker = join(binaryDirectory, "docker");
    await writeFile(
      docker,
      `#!/bin/sh
printf '%s|%s|%s|%s|%s\\n' "$*" "$SELFBENCH_EXECUTION_BACKEND" "$SELFBENCH_HARBOR_ENVIRONMENT" "$SELFBENCH_MODAL_CONFIG_PATH" "$SELFBENCH_BUILD_COMMIT" >> "$DOCKER_CALLS"
`,
    );
    await chmod(docker, 0o755);

    const child = Bun.spawn(
      [process.execPath, "src/cli.ts", "up", "--backend", "modal", "--modal-config", modalConfig],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          DOCKER_CALLS: calls,
          PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain("modal generation and modal Harbor");
    const invocations = await readFile(calls, "utf8");
    expect(invocations).not.toContain("Dockerfile.sandbox");
    expect(invocations).toContain("compose --file");
    expect(invocations).toContain(`|modal|modal|${modalConfig}|`);
    expect(invocations).toMatch(/\|[0-9a-f]{40}\n/);
  });
  test("requires an explicit Docker or Modal Harbor backend for Vercel", async () => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", "up", "--backend", "vercel"], {
      cwd: join(import.meta.dir, ".."),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--harbor-environment is required with --backend vercel");
  });
  test("requires explicit E2B Harbor, template, and API-key configuration", async () => {
    const projectRoot = join(import.meta.dir, "..");
    const missingHarbor = Bun.spawn([process.execPath, "src/cli.ts", "up", "--backend", "e2b"], {
      cwd: projectRoot,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [harborExit, harborError] = await Promise.all([
      missingHarbor.exited,
      new Response(missingHarbor.stderr).text(),
    ]);
    expect(harborExit).not.toBe(0);
    expect(harborError).toContain("--harbor-environment is required with --backend e2b");

    const missingTemplate = Bun.spawn(
      [process.execPath, "src/cli.ts", "up", "--backend", "e2b", "--harbor-environment", "docker"],
      {
        cwd: projectRoot,
        env: { ...process.env, E2B_API_KEY: "test-key", SELFBENCH_E2B_TEMPLATE: "" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [templateExit, templateError] = await Promise.all([
      missingTemplate.exited,
      new Response(missingTemplate.stderr).text(),
    ]);
    expect(templateExit).not.toBe(0);
    expect(templateError).toContain("SELFBENCH_E2B_TEMPLATE is required");
  });
  test("setup e2b fails clearly before external work without a name or API key", async () => {
    const projectRoot = join(import.meta.dir, "..");
    for (const [args, environment, message] of [
      [["setup", "e2b"], process.env, "--name is required"],
      [
        ["setup", "e2b", "--name", "selfbench-runtime:v1"],
        { ...process.env, E2B_API_KEY: "" },
        "E2B_API_KEY is required",
      ],
      [
        ["setup", "e2b", "--name", "Invalid Template"],
        { ...process.env, E2B_API_KEY: "not-a-live-key" },
        "invalid E2B template reference",
      ],
    ] as const) {
      const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
        cwd: projectRoot,
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).not.toBe(0);
      expect(stderr).toContain(message);
    }
  });
});
