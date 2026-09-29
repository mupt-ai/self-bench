import type { ParetoPlotProps, ParetoPoint } from "@mupt-ai/dari-pareto";
import { endpointNumber } from "../../../src/public/endpoint-numbers";
import type { PickRole, PublicPublisher, PublicSetting } from "./contract";

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
 * access and harness that tell them apart are appended, so points and rows stay distinct. Custom
 * models that still match (the same typed name on different endpoints, whose hosts are private)
 * are numbered "(Endpoint 1)", "(Endpoint 2)" by the `|#1`, `|#2` their ids end in, so the label
 * and the id always name the same setting; an older release's ids carry no number, and those
 * are numbered in release order.
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
    extra.push(`Endpoint ${endpointNumber(setting.id) ?? same.indexOf(setting) + 1}`);
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

export function compactNumber(value: number): string {
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

export const ROLE_LABELS: Record<PickRole, string> = {
  cheapest: "Cheapest",
  mostAccurate: "Most Accurate",
};

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

export function accessLabel(setting: Pick<PublicSetting, "custom" | "signIn" | "provider">) {
  if (setting.custom) return "Custom Endpoint";
  if (setting.signIn === "codex-login") return "ChatGPT Sign-In";
  return setting.provider === "openrouter" ? "OpenRouter" : "API Key";
}

export function reasoningLabel(setting: Pick<PublicSetting, "reasoningLevel">): string {
  const level = setting.reasoningLevel;
  return level === "xhigh" ? "X-High" : level.charAt(0).toUpperCase() + level.slice(1);
}

/** What a model's vendor is read from: a public setting, or a run in the app. */
type ModelSource = { provider: string; model: { name: string } };

/** The model's vendor, which colors its point: OpenRouter models by the vendor they route to. */
function vendor(setting: ModelSource): string {
  if (setting.provider !== "openrouter") return setting.provider;
  // Catalog names put the vendor first ("z-ai/glm-5.3"); some exports prefix the gateway.
  const [first, second] = setting.model.name.split("/");
  return (first === "openrouter" ? second : first) ?? "openrouter";
}

// Every vendor in the model catalog needs its own color here and a name in VENDOR_NAMES; an
// unlisted one would look like Custom (AGENTS.md, Model Vendors).
const VENDOR_COLORS: Record<string, string> = {
  openai: "#0f9f7a",
  anthropic: "#d4714e",
  google: "#3b7ddd",
  "z-ai": "#8b5cf6",
  deepseek: "#4f63d8",
  moonshotai: "#c0457a",
  custom: "#8a8580",
};

export function vendorColor(setting: ModelSource): string {
  return VENDOR_COLORS[vendor(setting)] ?? "#8a8580";
}

/** The group custom endpoints share, whatever model they serve. */
const CUSTOM_VENDOR = "Custom";

/** Vendors as they write their own names; any other vendor keeps its id. */
const VENDOR_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "z-ai": "Z.ai",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot AI",
  custom: CUSTOM_VENDOR,
};

/** The name of the model's vendor, for grouping points by who made the model. */
export function vendorName(setting: ModelSource): string {
  const id = vendor(setting);
  return VENDOR_NAMES[id] ?? id;
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
