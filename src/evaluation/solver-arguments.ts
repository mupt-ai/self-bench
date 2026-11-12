import type { HarborEnvironment } from "../contracts/config/providers.js";
import { harborRunArguments } from "../harnesses/harbor/command.js";
import { conditionArguments, type RunCondition } from "./conditions.js";
import type { SolverTrial } from "./gateway-trial.js";
import type { Harness } from "./models.js";

/** The `harbor run` arguments for a trial's solver, as its route resolved it (gatewayTrial). */
export function solverArguments(
  taskPath: string,
  jobs: string,
  solver: Pick<SolverTrial, "agent" | "model" | "agentArguments">,
  sandbox: HarborEnvironment,
  extraAllowedHosts: readonly string[] = [],
  verifierEnv: readonly string[] = [],
  /** The run condition the trial runs under, and the harness it applies to. */
  applied?: { condition: RunCondition | undefined; harness: Harness },
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
    conditionArguments: applied ? conditionArguments(applied.condition, applied.harness) : [],
  });
}
