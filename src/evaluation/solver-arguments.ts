import type { HarborEnvironment } from "../contracts/config/providers.js";
import { harborRunArguments } from "../harnesses/harbor/command.js";
import type { SolverTrial } from "./execution.js";

/** The `harbor run` arguments for a trial's solver, as its route resolved it (gatewayTrial). */
export function solverArguments(
  taskPath: string,
  jobs: string,
  solver: Pick<SolverTrial, "agent" | "model" | "agentArguments">,
  sandbox: HarborEnvironment,
  extraAllowedHosts: readonly string[] = [],
  verifierEnv: readonly string[] = [],
): string[] {
  return harborRunArguments({
    taskPath,
    jobsPath: jobs,
    jobName: "solver",
    agent: solver.agent,
    environment: sandbox,
    solver: { model: solver.model, agentArguments: solver.agentArguments },
    extraAllowedHosts,
    verifierEnv,
  });
}
