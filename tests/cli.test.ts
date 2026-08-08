import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/hash.js";
import { runCommand } from "../src/process.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SelfBench CLI", () => {
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
printf '%s|%s|%s|%s\\n' "$*" "$SELFBENCH_EXECUTION_BACKEND" "$SELFBENCH_HARBOR_ENVIRONMENT" "$SELFBENCH_MODAL_CONFIG_PATH" >> "$DOCKER_CALLS"
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
    expect(stdout).toContain("running with the modal backend");
    const invocations = await readFile(calls, "utf8");
    expect(invocations).not.toContain("Dockerfile.sandbox");
    expect(invocations).toContain("compose --file");
    expect(invocations).toContain(`|modal|modal|${modalConfig}`);
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
});
