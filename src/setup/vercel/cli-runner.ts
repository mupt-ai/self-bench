import { spawn } from "node:child_process";
import { type CommandOutputHandler, type CommandResult, runCommand } from "../../process.js";

export interface VercelCommandRunner {
  capture(
    args: readonly string[],
    options?: { readonly onOutput?: CommandOutputHandler },
  ): Promise<CommandResult>;
  interactive(args: readonly string[]): Promise<void>;
}

export class ProcessVercelCommandRunner implements VercelCommandRunner {
  async capture(
    args: readonly string[],
    options?: { readonly onOutput?: CommandOutputHandler },
  ): Promise<CommandResult> {
    return await runCommand("vercel", args, {
      allowFailure: true,
      ...(options?.onOutput ? { onOutput: options.onOutput } : {}),
    });
  }

  async interactive(args: readonly string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("vercel", args, { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `vercel ${args.slice(0, 2).join(" ")} exited ${code ?? `after ${signal ?? "signal"}`}`,
          ),
        );
      });
    });
  }
}
