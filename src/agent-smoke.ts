import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parallelMap } from "./parallel.js";
import { runCommand } from "./process.js";

export const HARBOR_AGENT_ADAPTERS = [
  "oracle",
  "nop",
  "acp",
  "terminus-2",
  "claude-code",
  "copilot-cli",
  "aider",
  "cline-cli",
  "codex",
  "cortex-code",
  "cursor-cli",
  "gemini-cli",
  "antigravity-cli",
  "antigravity-sdk",
  "rovodev-cli",
  "goose",
  "grok-build",
  "hermes",
  "kimi-code",
  "kimi-cli",
  "langgraph",
  "deerflow",
  "mini-swe-agent",
  "nemo-agent",
  "swe-agent",
  "opencode",
  "mimo",
  "openclaw",
  "openhands",
  "openhands-sdk",
  "pi",
  "qwen-coder",
  "devin",
  "trae-agent",
  "computer-1",
  "eve",
  "dspy-rlm",
  "vibe",
] as const;

export interface AdapterSmokeOptions {
  readonly taskDirectory: string;
  readonly jobsDirectory: string;
  readonly harborPath?: string;
  readonly environment?: "docker" | "modal";
  readonly concurrency?: number;
}

export interface AdapterSmokeResult {
  readonly agent: (typeof HARBOR_AGENT_ADAPTERS)[number];
  readonly installed: boolean;
  readonly exitCode: number;
  readonly jobName: string;
  readonly outputTail: string;
}

export async function smokeAllAdapters(
  options: AdapterSmokeOptions,
): Promise<readonly AdapterSmokeResult[]> {
  const jobsDirectory = resolve(options.jobsDirectory);
  const reportsDirectory = join(jobsDirectory, "adapter-smoke");
  await mkdir(reportsDirectory, { recursive: true });
  const results = await parallelMap(
    HARBOR_AGENT_ADAPTERS,
    options.concurrency ?? 4,
    async (agent) => {
      const reportPath = join(reportsDirectory, `${agent}.json`);
      const existing = await readFile(reportPath, "utf8").catch(() => undefined);
      if (existing) {
        return JSON.parse(existing) as AdapterSmokeResult;
      }
      const jobName = `install-${agent}-${crypto.randomUUID().slice(0, 8)}`;
      const result = await runCommand(
        options.harborPath ?? "harbor",
        [
          "run",
          "--path",
          resolve(options.taskDirectory),
          "--agent",
          agent,
          "--env",
          options.environment ?? "modal",
          "--job-name",
          jobName,
          "--jobs-dir",
          jobsDirectory,
          "--install-only",
          "--n-concurrent",
          "1",
          "--max-retries",
          "0",
          "--delete",
          "--yes",
          "--quiet",
        ],
        { allowFailure: true, timeoutMs: 60 * 60 * 1000 },
      );
      const summary: AdapterSmokeResult = {
        agent,
        installed: result.exitCode === 0,
        exitCode: result.exitCode,
        jobName,
        outputTail: `${result.stdout}\n${result.stderr}`.trim().slice(-2_000),
      };
      await writeFile(reportPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
      return summary;
    },
  );
  await writeFile(
    join(reportsDirectory, "summary.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        mode: "install-only",
        environment: options.environment ?? "modal",
        adapterCount: results.length,
        installed: results.filter((result) => result.installed).length,
        failed: results.filter((result) => !result.installed).length,
        results,
      },
      null,
      2,
    )}\n`,
  );
  return results;
}
