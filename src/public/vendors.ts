import { catalogModelId, isGateway } from "../gateways/index.js";

/**
 * Model vendors: one color and one display name each, for every place that shows a model, the
 * public site, the app's results chart, and the link preview images the server draws.
 */

/** What a model's vendor is read from: a public setting, or a run in the app. */
export type ModelSource = { provider: string; model: { name: string } };

/** The model's vendor, which colors its point: gateway models by the vendor they route to. */
function vendor(setting: ModelSource): string {
  if (!isGateway(setting.provider)) return setting.provider;
  // Catalog names put the vendor first ("z-ai/glm-5.3"); run names prefix the gateway, which may
  // spell the vendor its own way ("vercel-ai-gateway/zai/glm-5.3").
  const [first = "", ...rest] = setting.model.name.split("/");
  const gateway = isGateway(first) ? first : setting.provider;
  const name = isGateway(first) ? rest.join("/") : setting.model.name;
  return catalogModelId(gateway, name).split("/")[0] || gateway;
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
export const CUSTOM_VENDOR = "Custom";

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
