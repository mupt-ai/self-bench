import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/hash.js";
import { runCommand } from "../src/process.js";
import { saveVercelProfile } from "../src/setup/vercel/profile.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SelfBench CLI", () => {
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
      VERCEL_TOKEN: "token",
      VERCEL_TEAM_ID: "team",
      VERCEL_PROJECT_ID: "project",
    };

    for (const args of [
      ["up", "--backend", "vercel", "--harbor-environment", "docker"],
      ["up", "--backend", "vercel", "--harbor-environment", "modal", "--modal-config", modalConfig],
      ["up", "--backend", "modal", "--harbor-environment", "docker", "--modal-config", modalConfig],
      ["up", "--backend", "docker", "--harbor-environment", "modal", "--modal-config", modalConfig],
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
  });

  test("run --output waits for completion and downloads a verified export", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-cli-"));
    roots.push(root);
    const repository = join(root, "repo");
    const home = join(root, "home");
    const binaryDirectory = join(root, "bin");
    const sessionDirectory = join(home, ".codex/sessions");
    const output = join(root, "result.tar.gz");
    await Promise.all([
      mkdir(repository),
      mkdir(binaryDirectory),
      mkdir(sessionDirectory, { recursive: true }),
    ]);
    const gh = join(binaryDirectory, "gh");
    await writeFile(gh, "#!/bin/sh\nprintf '[]\\n'\n");
    await chmod(gh, 0o755);
    await runCommand("git", ["init", "-q", repository]);
    await runCommand("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    await runCommand("git", ["-C", repository, "config", "user.name", "Test"]);
    await writeFile(join(repository, "README.md"), "test repository\n");
    await runCommand("git", ["-C", repository, "add", "."]);
    await runCommand("git", ["-C", repository, "commit", "-qm", "base"]);
    await runCommand("git", [
      "-C",
      repository,
      "remote",
      "add",
      "origin",
      "https://github.com/example/project.git",
    ]);
    const repositoryWorktree = await realpath(repository);
    await writeFile(
      join(sessionDirectory, "session.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "session-1" } }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: `Build the feature in ${repositoryWorktree}` },
        }),
      ].join("\n"),
    );

    const exportBody = Buffer.from("verified export");
    let submittedRun: Record<string, unknown> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/v1/provenance") {
          return Response.json({
            uri: "local://provenance",
            sha256: "a".repeat(64),
            sizeBytes: 1,
            contentType: "application/x-ndjson",
          });
        }
        if (request.method === "POST" && url.pathname === "/v1/runs") {
          submittedRun = (await request.json()) as Record<string, unknown>;
          return Response.json({ runId: submittedRun.runId }, { status: 202 });
        }
        if (request.method === "GET" && /^\/v1\/runs\/[^/]+$/.test(url.pathname)) {
          return Response.json({
            runId: url.pathname.split("/").at(-1),
            phase: "complete",
            requested: 1,
            discovered: 1,
            accepted: 1,
            rejected: 0,
            tasks: [],
          });
        }
        if (request.method === "GET" && url.pathname.endsWith("/export")) {
          return new Response(exportBody, {
            headers: {
              "content-type": "application/gzip",
              "x-content-sha256": sha256(exportBody),
            },
          });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });

    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "src/cli.ts",
          "run",
          "--repo",
          repository,
          "--easy-count",
          "1",
          "--medium-count",
          "2",
          "--hard-count",
          "3",
          "--output",
          output,
        ],
        {
          cwd: join(import.meta.dir, ".."),
          env: {
            ...process.env,
            HOME: home,
            PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
            SELFBENCH_API_TOKEN: "",
            SELFBENCH_API_URL: `http://127.0.0.1:${server.port}`,
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
      expect(await readFile(output)).toEqual(exportBody);
      expect(submittedRun?.candidateCounts).toEqual({ easy: 1, medium: 2, hard: 3 });
      expect(stdout).toContain(`"output": "${output}"`);
      expect(stderr).toContain('"phase":"complete"');
    } finally {
      server.stop(true);
    }
  }, 10_000);

  test("download removes an output that fails streamed integrity verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-cli-download-"));
    roots.push(root);
    const output = join(root, "result.tar.gz");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response("corrupt export", {
          headers: { "x-content-sha256": sha256(Buffer.from("expected export")) },
        }),
    });

    try {
      const child = Bun.spawn([process.execPath, "src/cli.ts", "download", "example-run", output], {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          SELFBENCH_API_TOKEN: "",
          SELFBENCH_API_URL: `http://127.0.0.1:${server.port}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).not.toBe(0);
      expect(stderr).toContain("SHA-256 integrity check");
      expect(await readFile(output).catch(() => undefined)).toBeUndefined();
    } finally {
      server.stop(true);
    }
  });
});
