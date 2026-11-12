import type { CredentialInfo } from "../db/credentials.js";
import type { createGatewayUsageStore } from "../gateway/usage-store.js";
import type { SandboxCallback } from "../generation/pipeline/sandbox-job.js";
import { trialCost } from "./cost.js";
import { dariTrialCost } from "./dari/cost.js";
import { gatewayModelId, gatewayTrialTag } from "./gateway-trial.js";
import type { EvaluationRun, EvaluationTrial } from "./types.js";

/** SelfBench's model gateway, which a trial's agent and judge reach their models through. */
export interface TrialGateway {
  /** The API's address as sandboxes reach it, and the secret its trial keys are signed with. */
  readonly api: SandboxCallback;
  /** What the gateway recorded each trial's calls cost, and the tokens they used on each model. */
  readonly usage: Pick<ReturnType<typeof createGatewayUsageStore>, "trialCost" | "trialModels">;
}

/**
 * What the gateway recorded the trial's calls cost, which replaces any estimate: the provider's
 * own charge where it reports one (OpenRouter, Vercel AI Gateway), else the model's list price,
 * which on a sign-in's plan bills nothing. A trial with a call neither priced has no gateway cost;
 * nor does one that made no call.
 *
 * The total covers every model the trial's key served, so a run with a subagent model is priced
 * call by call at each call's own model. It is also what was billed only when every call was on
 * an API key: with the run's model or its subagents' on a sign-in, part of the total is the list
 * price of calls a plan covered, so no billed cost is recorded.
 */
async function gatewayTrialCost(
  gateway: TrialGateway,
  orgId: number,
  run: EvaluationRun,
  index: number,
  auth: CredentialInfo["auth"],
  subagentAuth?: CredentialInfo["auth"],
): Promise<Pick<EvaluationTrial, "apiCostUsd" | "billedCostUsd" | "costSource">> {
  const cost = await gateway.usage.trialCost(orgId, gatewayTrialTag(run, index));
  if (!cost?.complete) return {};
  const billed = auth === "api-key" && (!run.subagent || subagentAuth === "api-key");
  return {
    apiCostUsd: cost.costUsd,
    ...(billed ? { billedCostUsd: cost.costUsd } : {}),
    costSource: "gateway",
  };
}

/**
 * What a trial of a run with a subagent model used, from the gateway's records alone. No one
 * transcript measures such a trial: Harbor's Claude Code trajectory mixes the subagents' calls
 * into the run's own under the subagent model's name, and its Codex one holds a single session.
 * The gateway serves the trial's key exactly the run's model and its subagent model and records
 * each call's model and tokens, so the model is verified when the run's own model served calls
 * and nothing else but the subagent model did, and the tokens are both models' together.
 * `subagentCalls` is how many calls the subagent model served: none means the agent never
 * delegated, and the trial measured the run's model alone.
 */
async function subagentTrialUsage(
  gateway: TrialGateway,
  orgId: number,
  run: EvaluationRun,
  index: number,
): Promise<Pick<EvaluationTrial, "modelVerified" | "tokenUsage" | "subagentCalls">> {
  const models = await gateway.usage.trialModels(orgId, gatewayTrialTag(run, index));
  if (!run.subagent || models.length === 0) return {};
  const own = gatewayModelId(run);
  const served = new Set([own, run.subagent.model]);
  const sum = (count: (usage: (typeof models)[number]) => number) =>
    models.reduce((total, usage) => total + count(usage), 0);
  return {
    modelVerified:
      models.some((usage) => usage.model === own) &&
      models.every((usage) => served.has(usage.model)),
    tokenUsage: {
      input: sum((usage) => usage.input),
      output: sum((usage) => usage.output),
      cacheRead: sum((usage) => usage.cacheRead),
      cacheWrite: sum((usage) => usage.cacheWrite),
    },
    subagentCalls: models.find((usage) => usage.model === run.subagent?.model)?.calls ?? 0,
  };
}

/**
 * What a finished trial used and cost. A gateway trial's cost is the gateway's record of it, which
 * replaces the transcript's estimate. A run with a subagent model has no such estimate to
 * replace: one model's transcript and rates cannot measure a trial that called two, so its model,
 * tokens and cost all come from the gateway's records, and its cost stays unknown when any call
 * went unpriced.
 */
export async function measureTrial(
  run: EvaluationRun,
  trial: EvaluationTrial,
  index: number,
  /** Harbor's transcripts and result, and the environment its process ran with. */
  harbor: { records: Map<string, string>; result: unknown; child: NodeJS.ProcessEnv },
  /** The sign-in types of the run's credentials, and where the gateway recorded its calls. */
  route: {
    modelAuth: CredentialInfo["auth"];
    subagentAuth?: CredentialInfo["auth"] | undefined;
    gateway?: { at: TrialGateway; orgId: number } | undefined;
  },
): Promise<Partial<EvaluationTrial>> {
  const { gateway } = route;
  const measured = run.subagent
    ? gateway
      ? await subagentTrialUsage(gateway.at, gateway.orgId, run, index)
      : {}
    : {
        ...trialCost(run, trial.harness, harbor.records, harbor.result, route.modelAuth),
        ...(await dariTrialCost(run, trial, harbor.child, harbor.records)),
      };
  if (!gateway) return measured;
  return {
    ...measured,
    ...(await gatewayTrialCost(
      gateway.at,
      gateway.orgId,
      run,
      index,
      route.modelAuth,
      route.subagentAuth,
    )),
  };
}
