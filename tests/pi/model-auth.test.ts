import { afterEach, describe, expect, test } from "bun:test";
import { withExecutionEnvironment } from "../../src/contracts/config/execution-environment.js";
import {
  loadPiModelAuth,
  PI_DARI_LINK_KEY,
  piModelAuthSecrets,
} from "../../src/harnesses/pi/model-auth.js";

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.SELFBENCH_MANAGED_OPENROUTER_API_KEY;
  delete process.env.SELFBENCH_MANAGED_OFFERING;
});

describe("Pi model authentication", () => {
  test("prefers an OpenAI API key for Pi sandboxes", async () => {
    process.env.OPENAI_API_KEY = "  api-key  ";

    expect(await loadPiModelAuth()).toEqual({ provider: "openai", apiKey: "api-key" });
  });

  test("a stage on a Dari connection authenticates Pi as that connection, ahead of any OpenAI key", async () => {
    await withExecutionEnvironment(
      { [PI_DARI_LINK_KEY]: " dlk_ct_child ", OPENAI_API_KEY: "api-key" },
      async () => {
        const auth = await loadPiModelAuth();
        expect(auth).toEqual({ provider: "dari-link", apiKey: "dlk_ct_child" });
        // Its sandbox gets the child token under the variable the connection's models.json reads.
        expect(piModelAuthSecrets(auth)).toEqual({ OPENAI_API_KEY: "dlk_ct_child" });
      },
    );
  });

  test.each([
    ["openrouter", "OPENROUTER_API_KEY"],
    ["vercel-ai-gateway", "AI_GATEWAY_API_KEY"],
  ] as const)(
    "uses a run's %s key when no OpenAI or Anthropic key is present",
    async (provider, key) => {
      await withExecutionEnvironment({ [key]: " gateway-key " }, async () =>
        expect(await loadPiModelAuth()).toEqual({ provider, apiKey: "gateway-key" }),
      );
    },
  );

  test("falls back to the managed platform key for Compose workers without a model key", async () => {
    const ambient = {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      process.env.SELFBENCH_MANAGED_OPENROUTER_API_KEY = "managed-key";
      process.env.SELFBENCH_MANAGED_OFFERING = "true";
      expect(await loadPiModelAuth()).toEqual({ provider: "openrouter", apiKey: "managed-key" });
      // Without the managed offering the platform key is never used, and nothing else is.
      process.env.SELFBENCH_MANAGED_OFFERING = "false";
      expect(loadPiModelAuth()).rejects.toThrow("No model credential for Pi");
    } finally {
      for (const [key, value] of Object.entries(ambient))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });
});
