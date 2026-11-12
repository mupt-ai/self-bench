import { type Harness, harnessLabels } from "./models.js";

/**
 * A subagent model: the model a run's delegated agents call in place of the run's own, so one
 * model orchestrates and another does the delegated work. Claude Code takes it as its subagent
 * model override and Codex as its default subagent model (harbor_gateway.py), and both are told
 * to delegate. The other harnesses have no such setting in the Harbor adapters SelfBench runs.
 */
export const subagentSupport: Record<Harness, { configurable: boolean; description: string }> = {
  "claude-code": {
    configurable: true,
    description: "Configurable delegation model override.",
  },
  codex: {
    configurable: true,
    description: "Configurable default for delegated agents.",
  },
  pi: {
    configurable: false,
    description: "This adapter has no delegation extension.",
  },
  "mini-swe-agent": {
    configurable: false,
    description: "This adapter has no delegation model setting.",
  },
  "terminus-2": {
    configurable: false,
    description: "Summarization calls are not configurable delegated agents.",
  },
  "muse-code": {
    configurable: false,
    description: "This adapter has no verified delegation model override.",
  },
};

/** Whether every one of `harnesses` takes a subagent model. */
export function harnessesTakeSubagent(harnesses: readonly Harness[]): boolean {
  return (
    harnesses.length > 0 && harnesses.every((harness) => subagentSupport[harness].configurable)
  );
}

/**
 * Whether a credential of this kind can serve a run's own model beside a subagent model. Both of
 * the run's models go through SelfBench's gateway under one trial key, which serves each by name
 * and prices each call by the model it named. A custom endpoint's calls are priced by whichever
 * model its response says served them, so the gateway cannot price it beside a second model.
 */
export function providerTakesSubagent(provider: string): boolean {
  return provider !== "custom";
}

/**
 * Whether a credential of this kind can serve the subagent model: any that serves a catalog model
 * by name. Dari's router picks its own model for each call, and a custom endpoint's is unknown.
 */
export function providerServesSubagent(provider: string): boolean {
  return provider !== "custom" && provider !== "dari";
}

/**
 * Why a run on `provider`'s credential cannot give the subagents of `harnesses` a model on
 * `subagentProvider`'s, if it cannot. Trials that do not reach their model through the gateway
 * (trialRoute) are refused where the trial's route is known (comparison-save.ts, execution.ts).
 */
export function subagentRefusal(
  harnesses: readonly Harness[],
  provider: string,
  subagentProvider: string,
): string | undefined {
  const unsupported = harnesses.find((harness) => !subagentSupport[harness].configurable);
  if (unsupported)
    return `${harnessLabels[unsupported]} takes no subagent model: only Claude Code and Codex do`;
  if (!providerTakesSubagent(provider))
    return "A subagent model needs the run's own model on a credential the gateway serves and prices by name, which a custom endpoint is not";
  if (!providerServesSubagent(subagentProvider))
    return "Pick the subagent model on a credential that serves it by name: not Dari's router or a custom endpoint";
  return undefined;
}

/** Why a subagent model cannot run on a trial that does not go through the gateway. */
export const SUBAGENT_NEEDS_GATEWAY =
  "A subagent model runs only where the trial reaches its models through SelfBench's gateway, which serves and prices the second model";
