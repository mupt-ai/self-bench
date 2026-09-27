import { describe, expect, test } from "bun:test";
import type { TaskEnvironment } from "../src/contracts/index.js";
import {
  assertEnvironmentEvidence,
  assertEnvironmentPolicy,
  assertServicesSupported,
} from "../src/generation/task/environment-policy.js";

const environment: TaskEnvironment = {
  schemaVersion: 1,
  baseImage: `node:22-bookworm@sha256:${"a".repeat(64)}`,
  rootSetupCommand: "apt-get update && apt-get install -y bash git passwd procps tar",
  setupCommand: "corepack pnpm install --frozen-lockfile",
  smokeCommand: "corepack pnpm --version",
  environmentVariables: { CI: "1" },
  services: [
    {
      name: "postgres",
      image: `postgres:17@sha256:${"b".repeat(64)}`,
      environmentVariables: { POSTGRES_PASSWORD: "selfbench-local" },
      healthcheck: {
        test: ["CMD-SHELL", "pg_isready -U postgres"],
        intervalSeconds: 2,
        timeoutSeconds: 1,
        retries: 30,
        startPeriodSeconds: 0,
      },
    },
  ],
  source: "ci-adapted",
  evidence: [{ path: ".github/workflows/test.yml", reason: "Defines the test job." }],
};

describe("environment contracts", () => {
  test("accepts digest-pinned images and literal local service configuration", () => {
    expect(() => assertEnvironmentPolicy(environment)).not.toThrow();
  });

  test("rejects services where Harbor does not run Docker Compose", () => {
    expect(() => assertServicesSupported(environment, "e2b")).toThrow(
      "services (postgres) never start on E2B",
    );
    for (const harbor of ["docker", "modal", "vercel", "daytona"] as const) {
      expect(() => assertServicesSupported(environment, harbor)).not.toThrow();
    }
    expect(() => assertServicesSupported({ ...environment, services: [] }, "e2b")).not.toThrow();
  });

  test("rejects mutable images, host interpolation, and control characters", () => {
    expect(() => assertEnvironmentPolicy({ ...environment, baseImage: "node:22" })).toThrow(
      "pinned by sha256 digest",
    );
    expect(() =>
      assertEnvironmentPolicy({
        ...environment,
        environmentVariables: {
          // biome-ignore lint/suspicious/noTemplateCurlyInString: exercises host interpolation rejection.
          DATABASE_URL: "postgres://${DATABASE_PASSWORD}@postgres/db",
        },
      }),
    ).toThrow("must not interpolate host environment values");
    expect(() =>
      assertEnvironmentPolicy({
        ...environment,
        environmentVariables: { CI: "1\nRUN curl attacker" },
      }),
    ).toThrow("contains a control character");
  });

  test("allows secret-named variables that carry fixed placeholder literals", () => {
    expect(() =>
      assertEnvironmentPolicy({
        ...environment,
        environmentVariables: {
          SECRET_KEY: "selfbench-local-secret-key",
          API_KEY: "test",
          JWT_SECRET: "changeme",
          ACCESS_TOKEN: "xxxxxxxxxxxxxxxxxxxxxxxx",
          SESSION_SECRET: "",
          DJANGO_SECRET_KEY: "dev-secret",
          STRIPE_API_KEY: "not-a-real-key",
          JWT_SIGNING_SECRET: "insecure-jwt-signing-key-for-ci",
        },
      }),
    ).not.toThrow();
  });

  test("keeps rejecting secret-named variables that look like real key material", () => {
    const rejects = (value: string): void => {
      expect(() =>
        assertEnvironmentPolicy({ ...environment, environmentVariables: { SECRET_KEY: value } }),
      ).toThrow("looks like a secret");
    };
    rejects("9f2a7c41d3e8b56f0a1c4d7e2b9f8a6c3d5e1f7a9b2c4d6e");
    rejects("ghp_16C7e42F292c6912E7710c838347Ae178B4a");
    rejects("a9f3c2e1b7d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2");
    rejects("supersecretvalue1234");
    rejects("AKIAIOSFODNN7EXAMPLE");
    rejects("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    // A PEM header is refused even beside a placeholder word. Kept newline-free: a newline would be
    // refused as a control character before the secret check.
    rejects("-----BEGIN PRIVATE KEY-----example");
    expect(() =>
      assertEnvironmentPolicy({
        ...environment,
        // biome-ignore lint/suspicious/noTemplateCurlyInString: exercises host interpolation rejection.
        environmentVariables: { SECRET_KEY: "${HOST_SECRET}" },
      }),
    ).toThrow("must not interpolate host environment values");
  });

  test("rejects secret material and Docker-in-Docker setup", () => {
    expect(() =>
      assertEnvironmentPolicy({ ...environment, setupCommand: "echo $GITHUB_TOKEN" }),
    ).toThrow("references secret material");
    expect(() =>
      assertEnvironmentPolicy({ ...environment, rootSetupCommand: "docker build ." }),
    ).toThrow("must not invoke Docker-in-Docker");
  });

  test("requires evidence from the pinned repository", () => {
    expect(() =>
      assertEnvironmentEvidence(environment, new Set([".github/workflows/test.yml"])),
    ).not.toThrow();
    expect(() => assertEnvironmentEvidence(environment, new Set(["package.json"]))).toThrow(
      "does not exist at the pinned commit",
    );
  });
});
