import { afterEach, describe, expect, test } from "bun:test";
import { assertCodexSubscriptionAuth, loadPiSubscriptionAuth } from "../src/subscription-auth.js";

afterEach(() => {
  delete process.env.SELFBENCH_PI_AUTH_JSON;
});

describe("subscription authentication", () => {
  test("accepts a ChatGPT subscription token set", () => {
    expect(() =>
      assertCodexSubscriptionAuth({ auth_mode: "chatgpt", tokens: { access_token: "token" } }),
    ).not.toThrow();
  });

  test("rejects API-key authentication even when another token object is present", () => {
    expect(() =>
      assertCodexSubscriptionAuth({ auth_mode: "apikey", tokens: { access_token: "token" } }),
    ).toThrow("ChatGPT subscription token set");
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
