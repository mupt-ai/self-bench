import type { createGatewayUsageStore } from "../gateway/usage-store.js";
import type { SandboxCallback } from "../generation/pipeline/sandbox-job.js";
import { gatewayTrialTag } from "./trial-setup.js";
import type { EvaluationRun, EvaluationTrial } from "./types.js";

/** SelfBench's model gateway, which a trial on an API key reaches its model through. */
export interface TrialGateway {
  /** The API's address as sandboxes reach it, and the secret its trial keys are signed with. */
  readonly api: SandboxCallback;
  /** What the gateway recorded each trial's calls cost. */
  readonly usage: Pick<ReturnType<typeof createGatewayUsageStore>, "trialCost">;
}

/**
 * What the gateway recorded the trial's calls cost, which replaces any estimate: the provider's
 * own charge where it reports one (OpenRouter, Vercel AI Gateway), else the model's list price.
 * A call neither priced leaves the total incomplete. Nothing when the trial made no call.
 */
export async function gatewayTrialCost(
  gateway: TrialGateway,
  orgId: number,
  run: EvaluationRun,
  index: number,
): Promise<
  Pick<EvaluationTrial, "apiCostUsd" | "billedCostUsd" | "costSource" | "costIncomplete">
> {
  const cost = await gateway.usage.trialCost(orgId, gatewayTrialTag(run, index));
  if (!cost) return {};
  return {
    apiCostUsd: cost.costUsd,
    billedCostUsd: cost.costUsd,
    costSource: "gateway",
    ...(cost.complete ? {} : { costIncomplete: true }),
  };
}
