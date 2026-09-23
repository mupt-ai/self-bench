import { ModalClient } from "modal";
import type { SelfBenchWorkerConfig } from "../contracts/config/index.js";
import { runCommand } from "../lib/process.js";
import { DockerSandboxExecutor } from "./providers/docker/executor.js";
import { E2BSandboxExecutor } from "./providers/e2b/executor.js";
import { validateE2BWorkerStartup } from "./providers/e2b/startup.js";
import { ModalSandboxExecutor } from "./providers/modal/executor.js";
import { VercelSandboxExecutor } from "./providers/vercel/executor.js";
import { TimeoutCappedSandboxExecutor } from "./timeout.js";

export * from "./contracts.js";

import type { SandboxExecutor } from "./contracts.js";

export function createSandboxExecutor(
  config: SelfBenchWorkerConfig["execution"],
  environment?: NodeJS.ProcessEnv,
): SandboxExecutor {
  switch (config.kind) {
    case "docker":
      return new DockerSandboxExecutor(config);
    case "modal":
      return new ModalSandboxExecutor(
        config,
        environment
          ? new ModalClient({
              ...(environment.MODAL_TOKEN_ID ? { tokenId: environment.MODAL_TOKEN_ID } : {}),
              ...(environment.MODAL_TOKEN_SECRET
                ? { tokenSecret: environment.MODAL_TOKEN_SECRET }
                : {}),
            })
          : undefined,
      );
    case "vercel":
      return new TimeoutCappedSandboxExecutor(
        new VercelSandboxExecutor(config),
        config.timeoutCapMs,
      );
    case "e2b":
      return new TimeoutCappedSandboxExecutor(new E2BSandboxExecutor(config), config.timeoutCapMs);
  }
}

/** Fail at startup, not on the first activity, when a configured sandbox backend is unusable. */
export async function checkSandboxBackends(worker: SelfBenchWorkerConfig): Promise<void> {
  if (worker.execution.kind === "docker" || worker.harborEnvironment === "docker") {
    await runCommand("docker", ["info"], { timeoutMs: 30_000 });
    await runCommand("docker", ["compose", "version"], { timeoutMs: 30_000 });
  }
  if (worker.execution.kind === "e2b") {
    await validateE2BWorkerStartup(worker.execution);
  }
}
