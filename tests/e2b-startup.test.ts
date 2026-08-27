import { describe, expect, test } from "bun:test";
import { type E2BStartupApi, validateE2BWorkerStartup } from "../src/e2b-startup.js";

const config = {
  kind: "e2b" as const,
  image: "selfbench-runtime:v1",
  timeoutCapMs: 60 * 60 * 1_000,
  credentials: { apiKey: "e2b_test_key", domain: "custom.e2b.example" },
};

describe("E2B worker startup validation", () => {
  test("passes when the configured template exists", async () => {
    const api: E2BStartupApi = { exists: async () => true };
    await expect(validateE2BWorkerStartup(config, api)).resolves.toBeUndefined();
  });

  test("fails with a setup hint when the template is missing", async () => {
    const api: E2BStartupApi = { exists: async () => false };
    await expect(validateE2BWorkerStartup(config, api)).rejects.toThrow(
      "does not exist or is not accessible",
    );
    await expect(validateE2BWorkerStartup(config, api)).rejects.toThrow(
      `self-bench setup e2b --name ${config.image}`,
    );
  });

  test("fails when the control plane is unreachable", async () => {
    const api: E2BStartupApi = {
      exists: async () => {
        throw new Error("network unavailable");
      },
    };
    await expect(validateE2BWorkerStartup(config, api)).rejects.toThrow(
      "could not access template",
    );
  });

  test("bounds startup validation even when the control-plane call ignores abort", async () => {
    const api: E2BStartupApi = {
      exists: async () => await new Promise<boolean>(() => {}),
    };

    await expect(validateE2BWorkerStartup(config, api, 10)).rejects.toThrow(
      "could not access template",
    );
  });
});
