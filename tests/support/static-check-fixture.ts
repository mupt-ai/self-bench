import type { TaskDefinition } from "../../src/contracts/index.js";

export const goldPatch = `diff --git a/src/feature.ts b/src/feature.ts
new file mode 100644
--- /dev/null
+++ b/src/feature.ts
@@ -0,0 +1,25 @@
${Array.from({ length: 25 }, (_unused, index) => `+export const line${index} = ${index};`).join("\n")}
`;
export const testPatch = `diff --git a/tests/feature.test.ts b/tests/feature.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/feature.test.ts
@@ -0,0 +1 @@
+test("feature", () => {});
`;

export const definition: TaskDefinition = {
  schemaVersion: 2,
  difficulty: "easy",
  taskId: "static-check",
  repo: "example/repo",
  baseCommit: "a".repeat(40),
  workdir: ".",
  testCommand: "bun test {tests}",
  failToPass: ["tests/feature.test.ts"],
  passToPass: [],
  testPaths: ["tests/feature.test.ts"],
  sourcePr: 1,
  sourceUrl: "https://github.com/example/repo/pull/1",
  prompt: "Implement the feature.",
  timeouts: { setupSeconds: 900, agentSeconds: 2400, testsSeconds: 900 },
  resources: { cpus: 4, memoryMb: 8192, storageMb: 20480 },
  environment: {
    schemaVersion: 1,
    baseImage: `oven/bun:1@sha256:${"b".repeat(64)}`,
    rootSetupCommand: "apt-get update && apt-get install -y bash git passwd procps tar",
    setupCommand: "bun install --frozen-lockfile",
    smokeCommand: "bun --version",
    environmentVariables: { SECRET_KEY: "selfbench-local-secret" },
    services: [],
    source: "ci-adapted",
    evidence: [{ path: ".github/workflows/ci.yml", reason: "Runs bun test." }],
  },
};
