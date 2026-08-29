import { describe, expect, test } from "bun:test";
import { loadConfig, loadWorkerConfig } from "../src/config.js";
import {
  HOBBY_E2B_TIMEOUT_CAP_MS,
  HOBBY_VERCEL_TIMEOUT_CAP_MS,
  STANDARD_E2B_TIMEOUT_CAP_MS,
  STANDARD_VERCEL_TIMEOUT_CAP_MS,
} from "../src/sandbox/timeout.js";

const image = `iad1.vcr.dev/dari/selfbench/runtime@sha256:${"a".repeat(64)}`;

describe("SelfBench configuration", () => {
  test("preserves the matching Harbor defaults for Docker and Modal", () => {
    expect(
      loadConfig({
        SELFBENCH_ACTIVITY_CONCURRENCY: "",
        SELFBENCH_HARBOR_ENVIRONMENT: "",
        SELFBENCH_VERCEL_IMAGE: "",
      }).harborEnvironment,
    ).toBe("docker");
    expect(
      loadConfig({
        SELFBENCH_EXECUTION_BACKEND: "modal",
        SELFBENCH_HARBOR_ENVIRONMENT: "",
      }).harborEnvironment,
    ).toBe("modal");
  });

  test("uses a conservative Vercel concurrency within the initial Pro allocation rate", () => {
    const config = loadConfig({
      SELFBENCH_EXECUTION_BACKEND: "vercel",
      SELFBENCH_HARBOR_ENVIRONMENT: "docker",
      SELFBENCH_VERCEL_IMAGE: image,
    });

    expect(config.activityConcurrency).toBe(4);
    expect(
      loadConfig({
        SELFBENCH_EXECUTION_BACKEND: "vercel",
        SELFBENCH_HARBOR_ENVIRONMENT: "docker",
        SELFBENCH_VERCEL_IMAGE: image,
        SELFBENCH_ACTIVITY_CONCURRENCY: "6",
      }).activityConcurrency,
    ).toBe(6);
  });

  test("requires an explicit Docker or Modal Harbor backend for Vercel", () => {
    expect(() =>
      loadConfig({
        SELFBENCH_EXECUTION_BACKEND: "vercel",
        VERCEL_TOKEN: "token",
        VERCEL_TEAM_ID: "team",
        VERCEL_PROJECT_ID: "project",
        SELFBENCH_HARBOR_ENVIRONMENT: "",
        SELFBENCH_VERCEL_IMAGE: image,
      }),
    ).toThrow("SELFBENCH_HARBOR_ENVIRONMENT is required");
  });

  test("requires a complete nonblank Vercel credential triple", () => {
    const base = {
      SELFBENCH_EXECUTION_BACKEND: "vercel",
      SELFBENCH_HARBOR_ENVIRONMENT: "docker",
      SELFBENCH_VERCEL_IMAGE: image,
    };

    for (const credentials of [
      {},
      { VERCEL_TOKEN: "token" },
      { VERCEL_TOKEN: "token", VERCEL_TEAM_ID: "team" },
      {
        VERCEL_TOKEN: "token",
        VERCEL_TEAM_ID: "team",
        VERCEL_PROJECT_ID: "   ",
      },
    ]) {
      expect(() => loadWorkerConfig({ ...base, ...credentials })).toThrow(
        "VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID are required",
      );
    }
  });

  test("trims explicit Vercel credentials and retains the selected Harbor backend", () => {
    const config = loadWorkerConfig({
      SELFBENCH_EXECUTION_BACKEND: "vercel",
      SELFBENCH_HARBOR_ENVIRONMENT: "modal",
      SELFBENCH_VERCEL_IMAGE: `  ${image}  `,
      VERCEL_TOKEN: "  token  ",
      VERCEL_TEAM_ID: "  team  ",
      VERCEL_PROJECT_ID: "  project  ",
    });

    expect(config.execution).toEqual({
      kind: "vercel",
      credentials: {
        token: "token",
        teamId: "team",
        projectId: "project",
      },
      image,
      timeoutCapMs: STANDARD_VERCEL_TIMEOUT_CAP_MS,
    });
    expect(config.harborEnvironment).toBe("modal");
  });

  test("does not require worker credentials to load API metadata", () => {
    const config = loadConfig({
      SELFBENCH_EXECUTION_BACKEND: "vercel",
      SELFBENCH_HARBOR_ENVIRONMENT: "docker",
      SELFBENCH_VERCEL_IMAGE: image,
    });

    expect(config.execution).toEqual({
      kind: "vercel",
      image,
      timeoutCapMs: STANDARD_VERCEL_TIMEOUT_CAP_MS,
    });
  });

  test("parses explicit Vercel timeout caps and defaults to the standard stage ceiling", () => {
    const base = {
      SELFBENCH_EXECUTION_BACKEND: "vercel",
      SELFBENCH_HARBOR_ENVIRONMENT: "docker",
      SELFBENCH_VERCEL_IMAGE: image,
    };

    expect(loadConfig(base).execution).toMatchObject({
      timeoutCapMs: STANDARD_VERCEL_TIMEOUT_CAP_MS,
    });
    expect(loadConfig({ ...base, SELFBENCH_VERCEL_TIMEOUT_CAP: "45m" }).execution).toMatchObject({
      timeoutCapMs: HOBBY_VERCEL_TIMEOUT_CAP_MS,
    });
    expect(loadConfig({ ...base, SELFBENCH_VERCEL_TIMEOUT_CAP: "2700s" }).execution).toMatchObject({
      timeoutCapMs: HOBBY_VERCEL_TIMEOUT_CAP_MS,
    });
    expect(
      loadConfig({ ...base, SELFBENCH_VERCEL_TIMEOUT_CAP: "2700000" }).execution,
    ).toMatchObject({ timeoutCapMs: HOBBY_VERCEL_TIMEOUT_CAP_MS });
    expect(() => loadConfig({ ...base, SELFBENCH_VERCEL_TIMEOUT_CAP: "forty-five" })).toThrow();
    expect(() => loadConfig({ ...base, SELFBENCH_VERCEL_TIMEOUT_CAP: "3h" })).toThrow();
    expect(() => loadConfig({ ...base, SELFBENCH_VERCEL_TIMEOUT_CAP: "25h" })).toThrow();
  });

  test("does not let a malformed Vercel-only cap break Docker or Modal", () => {
    for (const backend of ["docker", "modal"] as const) {
      expect(
        loadConfig({
          SELFBENCH_EXECUTION_BACKEND: backend,
          SELFBENCH_VERCEL_TIMEOUT_CAP: "not-a-duration",
        }).execution.kind,
      ).toBe(backend);
      expect(
        loadConfig({
          SELFBENCH_EXECUTION_BACKEND: backend,
          SELFBENCH_VERCEL_TIMEOUT_CAP: "25h",
        }).execution.kind,
      ).toBe(backend);
    }
  });

  test("requires explicit E2B template, Harbor environment, and worker API key", () => {
    const base = {
      SELFBENCH_EXECUTION_BACKEND: "e2b",
      SELFBENCH_HARBOR_ENVIRONMENT: "docker",
    };

    expect(() => loadConfig(base)).toThrow("SELFBENCH_E2B_TEMPLATE is required");
    expect(() => loadConfig({ ...base, SELFBENCH_E2B_TEMPLATE: "base" })).toThrow(
      "must reference a custom SelfBench template",
    );
    expect(() => loadConfig({ ...base, SELFBENCH_E2B_TEMPLATE: "Not Lowercase" })).toThrow(
      "invalid E2B template reference",
    );
    expect(() =>
      loadConfig({
        ...base,
        SELFBENCH_E2B_TEMPLATE: "selfbench-runtime",
        SELFBENCH_HARBOR_ENVIRONMENT: "",
      }),
    ).toThrow("SELFBENCH_HARBOR_ENVIRONMENT is required");
    expect(() =>
      loadWorkerConfig({ ...base, SELFBENCH_E2B_TEMPLATE: "selfbench-runtime" }),
    ).toThrow("E2B_API_KEY is required");
    expect(() =>
      loadWorkerConfig({
        ...base,
        SELFBENCH_E2B_TEMPLATE: "team/selfbench-runtime:v1",
        E2B_API_KEY: "test-key",
        E2B_DOMAIN: "https://custom.e2b.example/path",
      }),
    ).toThrow("hostname without a scheme or path");
  });

  test("loads trimmed E2B worker settings and parses its timeout cap", () => {
    const config = loadWorkerConfig({
      SELFBENCH_EXECUTION_BACKEND: "e2b",
      SELFBENCH_HARBOR_ENVIRONMENT: "modal",
      SELFBENCH_E2B_TEMPLATE: "  selfbench-runtime:v1  ",
      SELFBENCH_E2B_TIMEOUT_CAP: "1h",
      E2B_API_KEY: "  e2b-key  ",
      E2B_DOMAIN: "  custom.e2b.example  ",
    });

    expect(config.execution).toEqual({
      kind: "e2b",
      image: "selfbench-runtime:v1",
      timeoutCapMs: HOBBY_E2B_TIMEOUT_CAP_MS,
      credentials: { apiKey: "e2b-key", domain: "custom.e2b.example" },
    });
    expect(config.harborEnvironment).toBe("modal");
    expect(config.activityConcurrency).toBe(4);
  });

  test("defaults E2B to the Hobby-compatible timeout and ignores stale values elsewhere", () => {
    expect(
      loadConfig({
        SELFBENCH_EXECUTION_BACKEND: "e2b",
        SELFBENCH_HARBOR_ENVIRONMENT: "docker",
        SELFBENCH_E2B_TEMPLATE: "selfbench-runtime",
      }).execution,
    ).toMatchObject({ timeoutCapMs: HOBBY_E2B_TIMEOUT_CAP_MS });
    expect(
      loadConfig({
        SELFBENCH_EXECUTION_BACKEND: "e2b",
        SELFBENCH_HARBOR_ENVIRONMENT: "docker",
        SELFBENCH_E2B_TEMPLATE: "selfbench-runtime",
        SELFBENCH_E2B_TIMEOUT_CAP: "24h",
      }).execution,
    ).toMatchObject({ timeoutCapMs: STANDARD_E2B_TIMEOUT_CAP_MS });
    expect(() =>
      loadConfig({
        SELFBENCH_EXECUTION_BACKEND: "e2b",
        SELFBENCH_HARBOR_ENVIRONMENT: "docker",
        SELFBENCH_E2B_TEMPLATE: "selfbench-runtime",
        SELFBENCH_E2B_TIMEOUT_CAP: "25h",
      }),
    ).toThrow();
    expect(loadConfig({ SELFBENCH_E2B_TIMEOUT_CAP: "not-a-duration" }).execution.kind).toBe(
      "docker",
    );
  });

  test("requires a digest-pinned Vercel image", () => {
    const base = {
      SELFBENCH_EXECUTION_BACKEND: "vercel",
      SELFBENCH_HARBOR_ENVIRONMENT: "docker",
      VERCEL_TOKEN: "token",
      VERCEL_TEAM_ID: "team",
      VERCEL_PROJECT_ID: "project",
    };

    expect(() => loadConfig(base)).toThrow("SELFBENCH_VERCEL_IMAGE is required");
    expect(() => loadConfig({ ...base, SELFBENCH_VERCEL_IMAGE: "vercel/sandbox/node:22" })).toThrow(
      "SELFBENCH_VERCEL_IMAGE must be pinned by sha256 digest",
    );
    expect(() =>
      loadConfig({ ...base, SELFBENCH_VERCEL_IMAGE: `@sha256:${"a".repeat(64)}` }),
    ).toThrow("SELFBENCH_VERCEL_IMAGE must be pinned by sha256 digest");
    expect(() =>
      loadConfig({ ...base, SELFBENCH_VERCEL_IMAGE: `repo@tag@sha256:${"a".repeat(64)}` }),
    ).toThrow("SELFBENCH_VERCEL_IMAGE must be pinned by sha256 digest");
  });
});
