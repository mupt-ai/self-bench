import { harnessLabels } from "../../../../src/evaluation/models";
import { vendorColor } from "../../public-site/format";
import { endpointLabel } from "./credential-presentation";
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

/** The model, and a custom endpoint's number when another endpoint serves the same model. */
export function configurationLabel(configuration: Configuration): string {
  const number = configuration.endpointNumber;
  return number ? `${configuration.label} (Endpoint ${number})` : configuration.label;
}

/** The configuration's model and harness, for sentences about it. */
export function configurationName(configuration: Configuration): string {
  return `${configurationLabel(configuration)} · ${harnessName(configuration.harness)}`;
}

/** How the model is reached: a custom endpoint's host, OpenRouter, a ChatGPT sign-in or an API key. */
function routeLabel(configuration: Configuration): string {
  if (configuration.provider === "custom") {
    return configuration.endpoint ? endpointLabel(configuration.endpoint) : "Deleted Endpoint";
  }
  if (configuration.signIn === "codex-login") return "ChatGPT Sign-In";
  if (configuration.provider === "openrouter") return "OpenRouter";
  return "API Key";
}

/** Reasoning, harness and route, under the model's name. */
export function configurationDetail(configuration: Configuration): string {
  return [
    thinkingLabel(configuration.thinking),
    harnessName(configuration.harness),
    routeLabel(configuration),
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
