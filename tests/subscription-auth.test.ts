import { afterEach, describe, expect, test } from "bun:test";
import { loadPiModelAuth, loadPiSubscriptionAuth } from "../src/subscription-auth.js";

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.SELFBENCH_PI_AUTH_JSON;
  delete process.env.SELFBENCH_MANAGED_OPENROUTER_API_KEY;
});

describe("subscription authentication", () => {
  test("prefers an OpenAI API key for Pi sandboxes", async () => {
    process.env.OPENAI_API_KEY = "  api-key  ";

    expect(await loadPiModelAuth()).toEqual({ provider: "openai", apiKey: "api-key" });
  });

  test("falls back to the managed platform key for Compose workers without a model key", async () => {
    const ambient = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      process.env.SELFBENCH_MANAGED_OPENROUTER_API_KEY = "managed-key";
      expect(await loadPiModelAuth()).toEqual({ provider: "openrouter", apiKey: "managed-key" });
    } finally {
      for (const [key, value] of Object.entries(ambient))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });

  test("passes only the OpenAI subscription credential to sandboxes", async () => {
    process.env.SELFBENCH_PI_AUTH_JSON = JSON.stringify({
      "openai-codex": { type: "oauth", access: "access", refresh: "refresh" },
      anthropic: { type: "api_key", key: "must-not-leave-the-host" },
    });

    expect(JSON.parse(await loadPiSubscriptionAuth())).toEqual({
      "openai-codex": { type: "oauth", access: "access", refresh: "refresh" },
    });
  });
});
