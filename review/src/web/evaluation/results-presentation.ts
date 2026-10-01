import type { CredentialInfo } from "../../../../src/db/credentials";
import { harnessLabels } from "../../../../src/evaluation/models";
import { isGateway } from "../../../../src/gateways";
import { vendorColor } from "../../public-site/format";
import type { EvaluationRun } from "./api";
import { endpointLabel, providers, signIns } from "./credential-presentation";
import type { Configuration, Outcome, TaskResult } from "./results-model";
import { thinkingLabel } from "./run-presentation";

export const outcomeLabels: Record<Outcome, string> = {
  passed: "Passed",
  failed: "Failed",
  unscored: "Not Scored",
  error: "Error",
  cancelled: "Cancelled",
  running: "Running",
  queued: "Queued",
  unrun: "Left Out",
  added: "Added Later",
};

/**
 * A task by its pull request when its id names one ("owner-repo-pr-123-short-title"): "PR #123",
 * and the title that follows the number, if any. Other ids stay as they are.
 */
export function taskParts(taskId: string): { name: string; title?: string } {
  const match = /(?:^|-)pr-(\d+)(?:-(.+))?$/.exec(taskId);
  if (!match) return { name: taskId };
  return { name: `PR #${match[1]}`, ...(match[2] ? { title: match[2] } : {}) };
}

function harnessName(harness: string): string {
  return harnessLabels[harness as keyof typeof harnessLabels] ?? harness;
}

/** The configuration's model and harness, for sentences about it. */
export function configurationName(configuration: Configuration): string {
  return `${configuration.label} · ${harnessName(configuration.harness)}`;
}

/**
 * How a run reached its model: a custom endpoint's host, a sign-in, a gateway, or the provider's
 * API key. Its model credential, while it exists, gives the endpoint, and the sign-in for runs
 * from before runs recorded it; a run whose sign-in is unknown shows its provider.
 */
export function routeLabel(
  run: EvaluationRun,
  credential?: Pick<CredentialInfo, "auth" | "endpoint">,
): string {
  const provider = run.credentials?.provider ?? "";
  if (provider === "custom") {
    return credential?.endpoint ? endpointLabel(credential.endpoint) : "Custom Endpoint";
  }
  const auth = run.credentials?.auth ?? credential?.auth;
  const signIn = signIns.find((entry) => entry.id === auth);
  if (signIn) return signIn.label;
  const name = providers.find((entry) => entry.id === provider)?.label ?? provider;
  return auth === "api-key" && !isGateway(provider) ? `${name} API Key` : name;
}

/** Reasoning, harness and the routes its runs took, under the model's name. */
export function configurationDetail(configuration: Configuration): string {
  return [
    thinkingLabel(configuration.thinking),
    harnessName(configuration.harness),
    configuration.routes.join(", "),
  ].join(" · ");
}

export function configurationColor(configuration: Configuration): string {
  return vendorColor({
    provider: configuration.provider,
    model: { name: configuration.modelName },
  });
}

const day = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const time = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "Sep 27, 14:05": when a batch started or something happened. */
export function momentLabel(iso: string): string {
  const date = new Date(iso);
  return `${day.format(date)}, ${time.format(date)}`;
}

export function minutesLabel(minutes: number | undefined): string {
  if (minutes === undefined) return "—";
  if (minutes < 1) return "<1 min";
  if (minutes < 120) return `${Math.round(minutes)} min`;
  return `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min`;
}

/** "36 passed · 3 failed · 1 error": the outcomes among some results, in a fixed order. */
export function outcomeSummary(results: readonly TaskResult[]): string {
  const words: [Outcome, string, string][] = [
    ["passed", "passed", "passed"],
    ["failed", "failed", "failed"],
    ["unscored", "not scored", "not scored"],
    ["error", "error", "errors"],
    ["running", "running", "running"],
    ["queued", "queued", "queued"],
    ["cancelled", "cancelled", "cancelled"],
  ];
  const parts = words.flatMap(([outcome, one, many]) => {
    const count = results.filter((result) => result.outcome === outcome).length;
    return count ? [`${count} ${count === 1 ? one : many}`] : [];
  });
  return parts.join(" · ");
}

/** The first line of an error, which is what repeats when many trials hit one cause. */
export function errorMessage(error: string | undefined): string {
  const line = (error ?? "").trim().split("\n")[0]?.trim() ?? "";
  if (!line) return "No error message";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
