import type { SelfBenchWorkerConfig } from "../config.js";
import { DockerSandboxExecutor } from "./providers/docker.js";
import { ModalSandboxExecutor } from "./providers/modal.js";
import { VercelSandboxExecutor } from "./providers/vercel/executor.js";
import { TimeoutCappedSandboxExecutor } from "./timeout.js";

export * from "./contracts.js";

import type { SandboxExecutor } from "./contracts.js";

export function createSandboxExecutor(config: SelfBenchWorkerConfig["execution"]): SandboxExecutor {
  switch (config.kind) {
    case "docker":
      return new DockerSandboxExecutor(config);
    case "modal":
      return new ModalSandboxExecutor(config);
    case "vercel":
      return new TimeoutCappedSandboxExecutor(
        new VercelSandboxExecutor(config),
        config.timeoutCapMs,
      );
  }
}
