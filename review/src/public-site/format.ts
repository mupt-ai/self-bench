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
 * access and harness that tell them apart are appended, so points and rows stay distinct.
 */
export function settingLabel(setting: PublicSetting, all: readonly PublicSetting[]): string {
  const twins = all.filter((other) => other.model.label === setting.model.label);
  if (twins.length < 2) return setting.model.label;
  const differs = (pick: (entry: PublicSetting) => string) =>
    new Set(twins.map(pick)).size > 1 ? pick(setting) : undefined;
  const extra = [differs(accessLabel), differs(harnessLabel), differs(reasoningLabel)].filter(
    Boolean,
  );
  return extra.length ? `${setting.model.label} (${extra.join(", ")})` : setting.model.label;
}

export function percent(value: number): string {
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
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

/** The model's vendor, which colors its point: OpenRouter models by the vendor they route to. */
function vendor(setting: Pick<PublicSetting, "provider" | "model">): string {
  if (setting.provider !== "openrouter") return setting.provider;
  // Catalog names put the vendor first ("z-ai/glm-5.3"); some exports prefix the gateway.
  const [first, second] = setting.model.name.split("/");
  return (first === "openrouter" ? second : first) ?? "openrouter";
}

const VENDOR_COLORS: Record<string, string> = {
  openai: "#0f9f7a",
  anthropic: "#d4714e",
  google: "#3b7ddd",
  "z-ai": "#8b5cf6",
  deepseek: "#4f63d8",
  moonshotai: "#c0457a",
  custom: "#8a8580",
};

export function vendorColor(setting: Pick<PublicSetting, "provider" | "model">): string {
  return VENDOR_COLORS[vendor(setting)] ?? "#8a8580";
}
