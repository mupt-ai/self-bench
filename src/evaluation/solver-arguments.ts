import type { HarborEnvironment } from "../contracts/config/providers.js";
import type { ThinkingLevel } from "../contracts/models.js";
import { harborRunArguments } from "../harnesses/harbor/command.js";
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
  });
}
