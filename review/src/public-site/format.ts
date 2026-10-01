import type { ParetoPlotProps, ParetoPoint } from "@mupt-ai/dari-pareto";
import { gateways, isGateway } from "../../../src/gateways/index";
import {
  CUSTOM_VENDOR,
  type ModelSource,
  vendorColor,
  vendorName,
} from "../../../src/public/vendors";
import type { PickRole, PublicPublisher, PublicSetting } from "./contract";

// Vendor colors and names are the server's too, for the link preview images; one table serves both.
export { vendorColor, vendorName } from "../../../src/public/vendors";

/** Display names for workspace logins whose GitHub name differs from the product name. */
const PUBLISHER_NAMES: Record<string, string> = { "mupt-ai": "dari.dev" };

export function publisherName(publisher: Pick<PublicPublisher, "login">): string {
  return PUBLISHER_NAMES[publisher.login.toLowerCase()] ?? publisher.login;
}

export function dollars(value: number): string {
  if (value === 0) return "$0";
  return `$${value.toFixed(value < 0.1 ? 3 : 2)}`;
}

/** GitHub descriptions often carry emoji shortcodes such as ":hedgehog:"; drop them. */
export function cleanDescription(text: string): string {
  return text.replace(/:[a-z0-9_+-]+:\s*/g, "").trim();
}

/**
 * The name shown for a setting. When two settings of one release share a model label, the
 * harness and reasoning that tell them apart are appended, so points and rows stay distinct.
 * Legacy releases may still contain separate access routes or numbered custom endpoints.
 */
export function settingLabel(setting: PublicSetting, all: readonly PublicSetting[]): string {
  const twins = all.filter((other) => other.model.label === setting.model.label);
  if (twins.length < 2) return setting.model.label;
  const visible = (entry: PublicSetting) =>
    [accessLabel(entry), harnessLabel(entry), reasoningLabel(entry)].join("|");
  const differs = (pick: (entry: PublicSetting) => string) =>
    new Set(twins.map(pick)).size > 1 ? pick(setting) : undefined;
  const extra = [differs(accessLabel), differs(harnessLabel), differs(reasoningLabel)].filter(
    Boolean,
  );
  const same = twins.filter((other) => other.custom && visible(other) === visible(setting));
  if (setting.custom && same.length > 1) {
    const number = /\|#(\d{1,3})$/.exec(setting.id)?.[1] ?? String(same.indexOf(setting) + 1);
    extra.push(`Endpoint ${number}`);
  }
  return extra.length ? `${setting.model.label} (${extra.join(", ")})` : setting.model.label;
}

export function percent(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

/**
 * An accuracy axis tick. The results charts leave headroom above 100% so the top points and
 * their labels clear the edge; a tick up there, such as 102.5% when every setting scored 100%,
 * is left unlabelled.
 */
export function accuracyTick(value: number): string {
  return value > 100 ? "" : percent(value);
}

/** A count as a star or card shows it: 950, 9.5k, 95k, 1.3M. The link preview images match. */
export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);
}

export function ago(iso: string, now = Date.now()): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  if (Number.isNaN(days)) return "";
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 31) return `${days} days ago`;
  return iso.slice(0, 10);
}

const ROLE_LABELS: Record<PickRole, string> = {
  cheapest: "Cheapest",
  mostAccurate: "Most Accurate",
};

/**
 * What a pick is called on a card. A setting that is both the cheapest and the most accurate, as
 * the only one on its frontier is, is called Most Accurate: both would not fit its column, and
 * being the cheapest of one says nothing.
 */
export function pickLabel(roles: readonly PickRole[]): string {
  return ROLE_LABELS[roles.includes("mostAccurate") ? "mostAccurate" : "cheapest"];
}

const HARNESS_LABELS: Record<PublicSetting["harness"], string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  pi: "Pi",
  "mini-swe-agent": "Mini-SWE-Agent",
  "terminus-2": "Terminus 2",
};

export function harnessLabel(setting: Pick<PublicSetting, "harness">): string {
  return HARNESS_LABELS[setting.harness];
}

function accessLabel(setting: Pick<PublicSetting, "custom" | "signIn" | "provider">) {
  if (!setting.signIn) return "Multiple Routes";
  if (setting.custom) return "Custom Endpoint";
  if (setting.signIn === "codex-login") return "ChatGPT Sign-In";
  if (setting.signIn === "claude-login") return "Claude Sign-In";
  return isGateway(setting.provider) ? gateways[setting.provider].label : "API Key";
}

export function reasoningLabel(setting: Pick<PublicSetting, "reasoningLevel">): string {
  const level = setting.reasoningLevel;
  return level === "xhigh" ? "X-High" : level.charAt(0).toUpperCase() + level.slice(1);
}

/**
 * The vendor chips of both results charts, the repository page's and the app's, so the two
 * never disagree: vendors with the most points first, left to right, and custom models last,
 * as one chip that opens to a chip per model, each in the next custom model color.
 */
export const VENDOR_CHIPS = {
  showGroups: true,
  groupOrder: { rest: "count", last: [CUSTOM_VENDOR] },
  palette: ["var(--custom-model-1)", "var(--custom-model-2)"],
} satisfies Pick<ParetoPlotProps, "showGroups" | "groupOrder" | "palette">;

/** A point's vendor color and chip, and for a custom model, the model's own chip in Custom. */
export function vendorPoint(
  source: ModelSource,
  customModel: string | undefined,
): Pick<ParetoPoint, "color" | "group" | "subgroup"> {
  return { color: vendorColor(source), group: vendorName(source), subgroup: customModel };
}
