import { afterEach, describe, expect, test } from "bun:test";
import { loadPiModelAuth, loadPiSubscriptionAuth } from "../src/subscription-auth.js";

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.SELFBENCH_PI_AUTH_JSON;
});

describe("subscription authentication", () => {
  test("prefers an OpenAI API key for Pi sandboxes", async () => {
    process.env.OPENAI_API_KEY = "  api-key  ";

    expect(await loadPiModelAuth()).toEqual({ provider: "openai", apiKey: "api-key" });
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
