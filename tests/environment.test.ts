import { describe, expect, test } from "bun:test";
import type { TaskDefinition, TaskEnvironment } from "../src/contracts.js";
import {
  assertEnvironmentEvidence,
  assertEnvironmentOnlyRepair,
  assertEnvironmentPolicy,
} from "../src/environment.js";

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

const definition: TaskDefinition = {
  schemaVersion: 2,
  difficulty: "easy",
  taskId: "environment-test",
  repo: "example/repo",
  baseCommit: "c".repeat(40),
  workdir: ".",
  testCommand: "pnpm test {tests}",
  failToPass: ["tests/new.test.ts"],
  passToPass: [],
  testPaths: ["tests/new.test.ts"],
  sourcePr: 1,
  sourceUrl: "https://github.com/example/repo/pull/1",
  prompt: "Implement behavior.",
  timeouts: { setupSeconds: 1, agentSeconds: 1, testsSeconds: 1 },
  resources: { cpus: 1, memoryMb: 1024, storageMb: 1024 },
  environment,
};

describe("environment contracts", () => {
  test("accepts digest-pinned images and literal local service configuration", () => {
    expect(() => assertEnvironmentPolicy(environment)).not.toThrow();
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

  test("allows environment-only repairs and rejects semantic changes", () => {
    const repaired = {
      ...definition,
      environment: { ...environment, setupCommand: `${environment.setupCommand} --offline` },
    };
    expect(() => assertEnvironmentOnlyRepair(definition, repaired)).not.toThrow();
    expect(() => assertEnvironmentOnlyRepair(definition, definition)).toThrow(
      "environment repair left the contract unchanged",
    );
    expect(() =>
      assertEnvironmentOnlyRepair(definition, { ...repaired, testCommand: "npm test {tests}" }),
    ).toThrow("environment repair changed task semantics");
  });
});
