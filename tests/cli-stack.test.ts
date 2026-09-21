import { describe, expect, test } from "bun:test";
import { join } from "node:path";

describe("SelfBench CLI setup", () => {
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
