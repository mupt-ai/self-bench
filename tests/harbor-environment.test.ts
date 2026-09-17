import { describe, expect, test } from "bun:test";
import {
  harborChildEnvironment,
  harborEnvironmentName,
  harborPythonPath,
} from "../src/harbor-environment.js";

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
      PATH: "/usr/bin",
    });
    expect(source.VERCEL_TOKEN).toBe("vercel-token");
    expect(source.E2B_API_KEY).toBe("e2b-key");
  });

  test("E2B Harbor keeps only the E2B key and domain and prefers the dedicated Harbor credential", () => {
    const source = {
      E2B_API_KEY: "generation-key",
      E2B_DOMAIN: "custom.e2b.example",
      E2B_DEBUG: "true",
      E2B_SANDBOX_URL: "https://sandbox.e2b.example",
      SELFBENCH_HARBOR_E2B_API_KEY: "harbor-key",
      VERCEL_TOKEN: "vercel-token",
      DAYTONA_API_KEY: "daytona-key",
      PATH: "/usr/bin",
    };
    expect(harborChildEnvironment(source, "e2b")).toEqual({
      E2B_API_KEY: "harbor-key",
      E2B_DOMAIN: "custom.e2b.example",
      PATH: "/usr/bin",
    });
    // A local stack shares one E2B key between generation and Harbor.
    const { SELFBENCH_HARBOR_E2B_API_KEY: _unused, ...shared } = source;
    expect(harborChildEnvironment(shared, "e2b").E2B_API_KEY).toBe("generation-key");
    // Other Harbor environments never see E2B settings or the Harbor E2B key.
    for (const environment of ["docker", "modal", "vercel", "daytona"] as const) {
      const child = harborChildEnvironment(source, environment);
      expect(Object.keys(child).filter((key) => key.includes("E2B"))).toEqual([]);
      expect(child.DAYTONA_API_KEY).toBe(environment === "daytona" ? "daytona-key" : undefined);
    }
  });

  test("Vercel Harbor keeps the token, team, and project and prefers the dedicated Harbor credential", () => {
    const source = {
      VERCEL_AUTH_TOKEN: "cli-token",
      VERCEL_TOKEN: "generation-token",
      VERCEL_TEAM_ID: "generation-team",
      VERCEL_PROJECT_ID: "generation-project",
      VERCEL_OIDC_TOKEN: "oidc",
      SELFBENCH_HARBOR_VERCEL_TOKEN: "harbor-token",
      SELFBENCH_HARBOR_VERCEL_TEAM_ID: "harbor-team",
      SELFBENCH_HARBOR_VERCEL_PROJECT_ID: "harbor-project",
      E2B_API_KEY: "e2b-key",
      PATH: "/usr/bin",
    };
    expect(harborChildEnvironment(source, "vercel")).toEqual({
      VERCEL_TOKEN: "harbor-token",
      VERCEL_TEAM_ID: "harbor-team",
      VERCEL_PROJECT_ID: "harbor-project",
      PATH: "/usr/bin",
    });
    // A local stack shares one Vercel credential between generation and Harbor.
    const shared = Object.fromEntries(
      Object.entries(source).filter(([key]) => !key.startsWith("SELFBENCH_HARBOR_")),
    );
    expect(harborChildEnvironment(shared, "vercel")).toEqual({
      VERCEL_TOKEN: "generation-token",
      VERCEL_TEAM_ID: "generation-team",
      VERCEL_PROJECT_ID: "generation-project",
      PATH: "/usr/bin",
    });
    // Other Harbor environments never see any Vercel credential.
    for (const environment of ["docker", "modal", "e2b", "daytona"] as const)
      expect(
        Object.keys(harborChildEnvironment(source, environment)).filter((key) =>
          key.includes("VERCEL"),
        ),
      ).toEqual([]);
  });
});

test("Harbor E2B gates and evaluations resolve the packaged one-hour environment", async () => {
  expect(harborEnvironmentName("e2b")).toBe("harbor_e2b:SelfBenchE2BEnvironment");
  for (const provider of ["modal", "docker", "vercel", "daytona"] as const)
    expect(harborEnvironmentName(provider)).toBe(provider);
  expect(await Bun.file(`${harborPythonPath()}/harbor_e2b.py`).exists()).toBe(true);
});

test("gate projection excludes unrelated secrets and refuses partial role credentials", () => {
  const source = {
    PATH: "/bin",
    GH_TOKEN: "github",
    SELFBENCH_DATABASE_URL: "secret",
    OPENAI_API_KEY: "model",
    MODAL_TOKEN_SECRET: "modal",
    DAYTONA_API_KEY: "daytona",
    E2B_API_KEY: "e2b",
  };
  expect(harborChildEnvironment(source, "e2b")).toEqual({ PATH: "/bin", E2B_API_KEY: "e2b" });
  expect(() =>
    harborChildEnvironment(
      { VERCEL_TOKEN: "ambient", SELFBENCH_HARBOR_VERCEL_TOKEN: "partial" },
      "vercel",
    ),
  ).toThrow("must include");
});
