import { describe, expect, test } from "bun:test";
import { harborChildEnvironment } from "../src/harbor-environment.js";

describe("Harbor child environment", () => {
  test("removes hosted sandbox control credentials while preserving selected Harbor credentials", () => {
    const source = {
      VERCEL_AUTH_TOKEN: "cli-token",
      VERCEL_TOKEN: "vercel-token",
      VERCEL_TEAM_ID: "team",
      VERCEL_PROJECT_ID: "project",
      VERCEL_OIDC_TOKEN: "oidc",
      E2B_API_KEY: "e2b-key",
      E2B_API_URL: "https://api.e2b.example",
      E2B_DEBUG: "true",
      E2B_DOMAIN: "custom.e2b.example",
      E2B_SANDBOX_URL: "https://sandbox.e2b.example",
      E2B_FUTURE_CONTROL_SETTING: "future-secret",
      MODAL_TOKEN_ID: "modal-id",
      MODAL_TOKEN_SECRET: "modal-secret",
      OPENAI_API_KEY: "workload-key",
      PATH: "/usr/bin",
    };

    expect(harborChildEnvironment(source)).toEqual({
      MODAL_TOKEN_ID: "modal-id",
      MODAL_TOKEN_SECRET: "modal-secret",
      OPENAI_API_KEY: "workload-key",
      PATH: "/usr/bin",
    });
    expect(source.VERCEL_TOKEN).toBe("vercel-token");
    expect(source.E2B_API_KEY).toBe("e2b-key");
  });
});
