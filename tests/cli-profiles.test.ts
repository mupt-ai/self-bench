import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveVercelProfile } from "../src/setup/vercel/profile.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SelfBench CLI profiles", () => {
  test("explains how to configure Vercel when no profile or complete environment exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-cli-missing-vercel-profile-"));
    roots.push(root);
    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "up",
        "--backend",
        "vercel",
        "--harbor-environment",
        "docker",
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          SELFBENCH_CONFIG_DIR: join(root, ".selfbench"),
          SELFBENCH_VERCEL_IMAGE: "",
          VERCEL_TOKEN: "",
          VERCEL_TEAM_ID: "",
          VERCEL_PROJECT_ID: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("run self-bench setup vercel");
    expect(stderr).toContain("VERCEL_TOKEN");
  });
  test("up resolves a saved Vercel profile without requiring exported credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-cli-vercel-profile-"));
    roots.push(root);
    const binaryDirectory = join(root, "bin");
    const configDirectory = join(root, ".selfbench");
    const calls = join(root, "docker-calls");
    await mkdir(binaryDirectory);
    await saveVercelProfile({
      directory: configDirectory,
      profileName: "default",
      token: "stored-vercel-token",
      profile: {
        teamId: "team_saved",
        teamSlug: "saved-team",
        teamName: "Saved Team",
        projectId: "prj_saved",
        projectName: "saved-project",
        vcrRepository: "selfbench-runtime",
        image: `selfbench-runtime@sha256:${"b".repeat(64)}`,
        runtimeFingerprint: "c".repeat(64),
        timeoutCapMs: 45 * 60 * 1_000,
        capabilityCheckedAt: "2026-08-16T12:00:00.000Z",
      },
    });
    const docker = join(binaryDirectory, "docker");
    await writeFile(
      docker,
      `#!/bin/sh
printf '%s|%s|%s|%s|%s\n' "$*" "$VERCEL_TEAM_ID" "$VERCEL_PROJECT_ID" "$SELFBENCH_VERCEL_IMAGE" "$SELFBENCH_VERCEL_TIMEOUT_CAP" >> "$DOCKER_CALLS"
`,
    );
    await chmod(docker, 0o755);

    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "up",
        "--backend",
        "vercel",
        "--harbor-environment",
        "docker",
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          DOCKER_CALLS: calls,
          PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
          SELFBENCH_CONFIG_DIR: configDirectory,
          SELFBENCH_VERCEL_IMAGE: "",
          VERCEL_TOKEN: "",
          VERCEL_TEAM_ID: "",
          VERCEL_PROJECT_ID: "",
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
    expect(stdout).toContain("vercel generation and docker Harbor");
    const invocation = await readFile(calls, "utf8");
    expect(invocation).toContain("|team_saved|prj_saved|");
    expect(invocation).toContain(`selfbench-runtime@sha256:${"b".repeat(64)}`);
    expect(invocation).toContain("|2700000ms\n");
    expect(invocation).not.toContain("stored-vercel-token");
  });
  test("configures every supported mixed generation and Harbor provider pair", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-cli-mixed-up-"));
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
printf '%s|%s|%s|%s\n' "$*" "$SELFBENCH_EXECUTION_BACKEND" "$SELFBENCH_HARBOR_ENVIRONMENT" "$SELFBENCH_MODAL_CONFIG_PATH" >> "$DOCKER_CALLS"
`,
    );
    await chmod(docker, 0o755);
    const environment = {
      ...process.env,
      DOCKER_CALLS: calls,
      PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
      SELFBENCH_VERCEL_IMAGE: `iad1.vcr.dev/dari/selfbench/runtime@sha256:${"a".repeat(64)}`,
      SELFBENCH_E2B_TEMPLATE: "selfbench-runtime:v1",
      E2B_API_KEY: "e2b-key",
      VERCEL_TOKEN: "token",
      VERCEL_TEAM_ID: "team",
      VERCEL_PROJECT_ID: "project",
    };

    for (const args of [
      ["up", "--backend", "vercel", "--harbor-environment", "docker"],
      ["up", "--backend", "vercel", "--harbor-environment", "modal", "--modal-config", modalConfig],
      ["up", "--backend", "modal", "--harbor-environment", "docker", "--modal-config", modalConfig],
      ["up", "--backend", "docker", "--harbor-environment", "modal", "--modal-config", modalConfig],
      ["up", "--backend", "e2b", "--harbor-environment", "docker"],
      ["up", "--backend", "e2b", "--harbor-environment", "modal", "--modal-config", modalConfig],
    ]) {
      const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
        cwd: join(import.meta.dir, ".."),
        env: environment,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(exitCode, stderr).toBe(0);
    }

    const invocations = (await readFile(calls, "utf8")).trim().split("\n");
    const vercelWithDockerHarbor = invocations.filter((line) => line.includes("|vercel|docker|"));
    expect(vercelWithDockerHarbor).toHaveLength(1);
    expect(vercelWithDockerHarbor[0]).not.toContain("Dockerfile.sandbox");

    const vercelWithModalHarbor = invocations.filter((line) =>
      line.includes(`|vercel|modal|${modalConfig}`),
    );
    expect(vercelWithModalHarbor).toHaveLength(1);
    expect(vercelWithModalHarbor[0]).not.toContain("Dockerfile.sandbox");

    const modalWithDockerHarbor = invocations.filter((line) =>
      line.includes(`|modal|docker|${modalConfig}`),
    );
    expect(modalWithDockerHarbor).toHaveLength(1);
    expect(modalWithDockerHarbor[0]).not.toContain("Dockerfile.sandbox");

    const dockerWithModalHarbor = invocations.filter((line) =>
      line.includes(`|docker|modal|${modalConfig}`),
    );
    expect(dockerWithModalHarbor).toHaveLength(2);
    expect(dockerWithModalHarbor.some((line) => line.includes("Dockerfile.sandbox"))).toBe(true);

    const e2bWithDockerHarbor = invocations.filter((line) => line.includes("|e2b|docker|"));
    expect(e2bWithDockerHarbor).toHaveLength(1);
    expect(e2bWithDockerHarbor[0]).not.toContain("Dockerfile.sandbox");

    const e2bWithModalHarbor = invocations.filter((line) =>
      line.includes(`|e2b|modal|${modalConfig}`),
    );
    expect(e2bWithModalHarbor).toHaveLength(1);
    expect(e2bWithModalHarbor[0]).not.toContain("Dockerfile.sandbox");
  });
});
