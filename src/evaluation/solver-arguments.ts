import type { HarborEnvironment } from "../contracts/config/providers.js";
import type { ThinkingLevel } from "../contracts/models.js";
import type { TaskImages } from "../contracts/task.js";
import { harborRunArguments } from "../harnesses/harbor/command.js";
import { pinnedImageKwargs } from "../harnesses/harbor/pinned-images.js";
import { solverAgent, solverAgentArguments } from "./execution.js";
import type { Harness } from "./types.js";

export function solverArguments(
  taskPath: string,
  jobs: string,
  harness: Harness,
  model: string,
  sandbox: HarborEnvironment,
  thinking?: ThinkingLevel,
  extraAllowedHosts: readonly string[] = [],
  images?: TaskImages,
  provider?: string,
  verifierEnv: readonly string[] = [],
): string[] {
  return harborRunArguments({
    taskPath,
    jobsPath: jobs,
    jobName: "solver",
    agent: solverAgent(harness, provider, model),
    environment: sandbox,
    solver: { model, agentArguments: solverAgentArguments(harness, provider, model, thinking) },
    extraAllowedHosts,
    verifierEnv,
    // Pinned images are Modal image IDs; every other backend builds the task's Dockerfiles.
    ...(sandbox === "modal" ? { environmentKwargs: pinnedImageKwargs(images) } : {}),
  });
}
