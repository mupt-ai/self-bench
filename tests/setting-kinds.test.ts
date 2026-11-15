import { describe, expect, it } from "bun:test";
import { settingKind } from "../src/public/setting-kinds.js";

const setting = (catalogId: string, provider: string, custom = false) => ({
  custom,
  provider,
  model: { catalogId },
});

describe("settingKind", () => {
  it("counts custom endpoints, router providers, and listed router models as routers", () => {
    expect(settingKind(setting("custom/shift-1", "custom", true))).toBe("router");
    expect(settingKind(setting("dari/routing", "dari"))).toBe("router");
    expect(settingKind(setting("typesafe/jev-router", "openrouter"))).toBe("router");
  });

  it("counts a vendor's model as a model, through a gateway too", () => {
    expect(settingKind(setting("gpt-6-luna", "openai"))).toBe("model");
    expect(settingKind(setting("kimi-k3", "vercel-ai-gateway"))).toBe("model");
  });
});
