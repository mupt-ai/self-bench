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

describe("SelfBench CLI run", () => {
  test("run --output waits for completion and downloads a verified export", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-cli-"));
    roots.push(root);
    const repository = join(root, "repo");
    const home = join(root, "home");
    const binaryDirectory = join(root, "bin");
    const sessionDirectory = join(home, ".codex/sessions");
    const output = join(root, "result.tar.gz");
    const association = join(root, "association.json");
    await Promise.all([
      mkdir(repository),
      mkdir(binaryDirectory),
      mkdir(sessionDirectory, { recursive: true }),
    ]);
    const gh = join(binaryDirectory, "gh");
    await writeFile(gh, "#!/bin/sh\nexit 99\n");
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
    const request = `Build the feature in ${repositoryWorktree}`;
    await writeFile(
      join(sessionDirectory, "session.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "session-1" } }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "user_message", message: request },
        }),
      ].join("\n"),
    );
    await writeFile(
      association,
      JSON.stringify({
        schemaVersion: 1,
        repository: "example/project",
        sourcePr: 42,
        sourceUrl: "https://github.com/example/project/pull/42",
        messages: [
          {
            sourceType: "codex",
            sessionId: "session-1",
            messageIndex: 0,
            contentSha256: sha256(request),
          },
        ],
      }),
    );

    const exportBody = Buffer.from("verified export");
    let uploadedProvenance = "";
    let submittedRun: Record<string, unknown> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (request.method === "POST" && url.pathname === "/v1/provenance") {
          uploadedProvenance = await request.text();
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
          "--association",
          association,
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
      expect(uploadedProvenance).toContain("Build the feature");
      expect(JSON.parse(uploadedProvenance)).toMatchObject({
        content: request,
        sourcePr: 42,
        sourceUrl: "https://github.com/example/project/pull/42",
      });
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
