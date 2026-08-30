import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/hash.js";
import { runCommand } from "../src/process.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SelfBench CLI association", () => {
  test("associate verifies a merged PR and writes a private text-free manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-cli-associate-"));
    roots.push(root);
    const repository = join(root, "repo");
    const home = join(root, "home");
    const binaryDirectory = join(root, "bin");
    const sessionDirectory = join(home, ".pi/agent/sessions/repository");
    const output = join(root, "association.json");
    await Promise.all([
      mkdir(repository),
      mkdir(binaryDirectory),
      mkdir(sessionDirectory, { recursive: true }),
    ]);
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
    const request = `Build the private feature in ${repositoryWorktree}`;
    await writeFile(
      join(sessionDirectory, "session.jsonl"),
      [
        JSON.stringify({
          type: "session",
          id: "session-1",
          cwd: repositoryWorktree,
          timestamp: "2026-08-24T00:00:00Z",
        }),
        JSON.stringify({
          type: "message",
          parentId: "parent",
          message: { role: "user", content: request },
        }),
      ].join("\n"),
    );
    const gh = join(binaryDirectory, "gh");
    await writeFile(
      gh,
      `#!/bin/sh
printf '%s\\n' '{"number":42,"url":"https://github.com/example/project/pull/42","state":"MERGED","mergedAt":"2026-08-23T00:00:00Z"}'
`,
    );
    await chmod(gh, 0o755);

    const listChild = Bun.spawn(
      [process.execPath, "src/cli.ts", "associate", "--repo", repository, "--list-sessions"],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          HOME: home,
          PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [listExitCode, listStdout, listStderr] = await Promise.all([
      listChild.exited,
      new Response(listChild.stdout).text(),
      new Response(listChild.stderr).text(),
    ]);
    expect(listExitCode, listStderr).toBe(0);
    expect(JSON.parse(listStdout)).toEqual({
      repository: "https://github.com/example/project.git",
      sessions: [
        {
          selector: "pi:session-1",
          sourceType: "pi",
          sessionId: "session-1",
          messageCount: 1,
          modifiedAt: expect.any(String),
          paths: ["~/.pi/agent/sessions/repository/session.jsonl"],
        },
      ],
    });
    expect(listStdout).not.toContain(request);

    const child = Bun.spawn(
      [
        process.execPath,
        "src/cli.ts",
        "associate",
        "--repo",
        repository,
        "--pr",
        "42",
        "--session",
        "pi:session-1",
        "--output",
        output,
      ],
      {
        cwd: join(import.meta.dir, ".."),
        env: {
          ...process.env,
          HOME: home,
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
    const manifest = JSON.parse(await readFile(output, "utf8"));
    expect(manifest).toEqual({
      schemaVersion: 1,
      repository: "example/project",
      sourcePr: 42,
      sourceUrl: "https://github.com/example/project/pull/42",
      messages: [
        {
          sourceType: "pi",
          sessionId: "session-1",
          messageIndex: 0,
          contentSha256: sha256(request),
        },
      ],
    });
    expect(JSON.stringify(manifest)).not.toContain("Build the private feature");
    expect(stdout).not.toContain("Build the private feature");
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });
});
