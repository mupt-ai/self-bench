import { describe, expect, test } from "bun:test";
import type { CommandOutputHandler, CommandResult } from "../src/process.js";
import { VercelCli, type VercelCommandRunner } from "../src/vercel-cli.js";

class FakeRunner implements VercelCommandRunner {
  readonly captured: string[][] = [];
  readonly interactiveCalls: string[][] = [];
  readonly results: CommandResult[] = [];
  onInteractive: (() => void) | undefined;

  async capture(
    args: readonly string[],
    options?: { readonly onOutput?: CommandOutputHandler },
  ): Promise<CommandResult> {
    this.captured.push([...args]);
    const result = this.results.shift();
    if (!result) {
      throw new Error(`unexpected capture: ${args.join(" ")}`);
    }
    if (result.stdout) {
      options?.onOutput?.("stdout", Buffer.from(result.stdout));
    }
    if (result.stderr) {
      options?.onOutput?.("stderr", Buffer.from(result.stderr));
    }
    return result;
  }

  async interactive(args: readonly string[]): Promise<void> {
    this.interactiveCalls.push([...args]);
    this.onInteractive?.();
  }

  enqueueJson(value: unknown, exitCode = 0): void {
    this.results.push({ stdout: JSON.stringify(value), stderr: "", exitCode });
  }

  enqueueText(stdout: string, exitCode = 0, stderr = ""): void {
    this.results.push({ stdout, stderr, exitCode });
  }
}

describe("VercelCli", () => {
  test("requires the audited CLI version and completes browser login when needed", async () => {
    const runner = new FakeRunner();
    runner.enqueueText("Vercel CLI 59.1.3\n");
    runner.enqueueJson({ loggedIn: false }, 1);
    runner.enqueueJson({ loggedIn: true, user: { username: "test" } });
    const cli = new VercelCli(runner);

    await cli.ensureAvailable();
    await cli.ensureLoggedIn();

    expect(runner.interactiveCalls).toEqual([["login"]]);
    expect(runner.captured[0]).toEqual(["--version"]);
    expect(runner.captured[1]).toContain("--non-interactive");
  });

  test("rejects missing or outdated CLI versions with an exact install command", async () => {
    const runner = new FakeRunner();
    runner.enqueueText("Vercel CLI 58.9.0\n");

    await expect(new VercelCli(runner).ensureAvailable()).rejects.toThrow(
      "npm install --global vercel@latest",
    );
  });

  test("paginates and deduplicates team and project listings", async () => {
    const runner = new FakeRunner();
    runner.enqueueJson({
      teams: [{ id: "team_a", slug: "a", name: "A", current: true }],
      pagination: { next: 123 },
    });
    runner.enqueueJson({
      teams: [
        { id: "team_a", slug: "a", name: "A", current: true },
        { id: "team_b", slug: "b", name: "B" },
      ],
      pagination: { next: null },
    });
    runner.enqueueJson({
      projects: [{ id: "prj_a", name: "first" }],
      pagination: { next: "456" },
    });
    runner.enqueueJson({
      projects: [{ id: "prj_b", name: "second" }],
      pagination: { next: null },
    });
    const cli = new VercelCli(runner);

    expect(await cli.listTeams()).toHaveLength(2);
    expect(await cli.listProjects("a")).toEqual([
      { id: "prj_a", name: "first" },
      { id: "prj_b", name: "second" },
    ]);
    expect(runner.captured[1]).toContain("123");
    expect(runner.captured[3]).toContain("456");
    expect(runner.captured[2]).toContain("--scope");
    expect(runner.captured[2]).toContain("a");
  });

  test("keeps VCR lookup project-scoped and publishes the exact sandbox Dockerfile", async () => {
    const runner = new FakeRunner();
    runner.enqueueText("", 1, '{"error":{"code":"not_found"}}');
    runner.enqueueJson({ repository: { id: "repo", name: "selfbench-runtime" } });
    runner.enqueueJson({
      tags: [
        {
          tag: "selfbench-abc",
          manifestDigest: `sha256:${"a".repeat(64)}`,
          status: "ready",
        },
      ],
      nextCursor: null,
    });
    runner.enqueueText("registry login\n");
    runner.enqueueText("build output\n", 0, "build warning\n");
    const cli = new VercelCli(runner);
    const scope = {
      teamSlug: "test-team",
      projectId: "prj_test",
      repository: "selfbench-runtime",
    };

    expect(await cli.repositoryExists(scope)).toBe(false);
    await cli.createRepository(scope);
    expect(await cli.listTags(scope)).toHaveLength(1);
    const output: string[] = [];
    await cli.buildImage({
      ...scope,
      tag: "selfbench-abc",
      projectRoot: "/repo",
      onOutput: (stream, chunk) => output.push(`${stream}:${Buffer.from(chunk).toString()}`),
    });

    for (const args of runner.captured) {
      expect(args).toContain("--project");
      expect(args).toContain("prj_test");
      expect(args).toContain("--scope");
      expect(args).toContain("test-team");
    }
    expect(runner.interactiveCalls).toEqual([]);
    expect(runner.captured.at(-2)).toEqual([
      "vcr",
      "login",
      "docker",
      "--project",
      "prj_test",
      "--scope",
      "test-team",
      "--non-interactive",
    ]);
    expect(runner.captured.at(-1)).toEqual([
      "vcr",
      "build",
      "docker",
      "/repo",
      "selfbench-runtime:selfbench-abc",
      "--project",
      "prj_test",
      "--platform",
      "linux/amd64",
      "--push",
      "--scope",
      "test-team",
      "--non-interactive",
      "--",
      "--file",
      "/repo/Dockerfile.sandbox",
      "--provenance=false",
    ]);
    expect(output).toEqual([
      "stdout:registry login\n",
      "stdout:build output\n",
      "stderr:build warning\n",
    ]);
  });
});
