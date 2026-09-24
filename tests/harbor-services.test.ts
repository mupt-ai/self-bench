import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskDefinition } from "../src/contracts/index.js";
import { staticCheckSubmission } from "../src/generation/task/static.js";
import { runCommand } from "../src/lib/process.js";
import { definition, goldPatch, testPatch } from "./support/static-check-fixture.js";

const withService: TaskDefinition = {
  ...definition,
  environment: {
    ...definition.environment,
    services: [
      {
        name: "postgres",
        image: `postgres:17@sha256:${"c".repeat(64)}`,
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
  },
};

test("services are rejected at submit time when Harbor verifies on E2B", () => {
  const submission = (harborEnvironment: "e2b" | "modal") =>
    staticCheckSubmission({
      definitionJson: JSON.stringify(withService),
      testPatch,
      goldPatch,
      harborEnvironment,
    });
  expect(submission("e2b").errors).toContainEqual({
    gate: "policy",
    message: expect.stringContaining("services (postgres) never start on E2B"),
  });
  expect(submission("modal").errors).toEqual([]);
});

test("the sandbox-check program applies the Harbor environment it is given", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfbench-check-"));
  try {
    await Promise.all([
      writeFile(join(root, "definition.json"), JSON.stringify(withService)),
      writeFile(join(root, "test.patch"), testPatch),
      writeFile(join(root, "gold.patch"), goldPatch),
    ]);
    const result = await runCommand(
      "bun",
      [
        "run",
        "src/sandbox/programs/check.ts",
        join(root, "definition.json"),
        join(root, "test.patch"),
        join(root, "gold.patch"),
        root,
      ],
      { env: { ...process.env, SELFBENCH_HARBOR_ENVIRONMENT: "e2b" } },
    );
    const verdict = JSON.parse(result.stdout) as { ok: boolean; errors: unknown[] };
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toContainEqual({
      gate: "policy",
      message: expect.stringContaining("never start on E2B"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
