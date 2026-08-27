import type { SelfBenchWorkerConfig } from "../config.js";
import { DockerSandboxExecutor } from "./providers/docker/executor.js";
import { E2BSandboxExecutor } from "./providers/e2b/executor.js";
import { ModalSandboxExecutor } from "./providers/modal/executor.js";
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
    case "e2b":
      return new TimeoutCappedSandboxExecutor(new E2BSandboxExecutor(config), config.timeoutCapMs);
  }
}
