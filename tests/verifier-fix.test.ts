import { describe, expect, test } from "bun:test";
import type { TaskDefinition } from "../src/contracts.js";
import { applyVerifierFix, assertVerifierFix } from "../src/verifier-fix.js";

const testPatch = `diff --git a/tests/behavior.test.ts b/tests/behavior.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/behavior.test.ts
@@ -0,0 +1 @@
+test
`;
const goldPatch = `diff --git a/src/feature.ts b/src/feature.ts
new file mode 100644
--- /dev/null
+++ b/src/feature.ts
@@ -0,0 +1 @@
+export const feature = 1;
`;

const definition: TaskDefinition = {
  schemaVersion: 2,
  difficulty: "easy",
  taskId: "task",
  repo: "example/repo",
  baseCommit: "a".repeat(40),
  workdir: ".",
  testCommand: "npm test -- {tests}",
  failToPass: ["tests/behavior.test.ts"],
  passToPass: [],
  testPaths: ["tests/behavior.test.ts"],
  environment: {
    schemaVersion: 1,
    baseImage: `node:22@sha256:${"b".repeat(64)}`,
    rootSetupCommand: "apt-get update && apt-get install -y bash git passwd procps tar",
    setupCommand: "npm ci",
    smokeCommand: "npm --version",
    environmentVariables: {},
    services: [],
    source: "ci-adapted",
    evidence: [{ path: "package.json", reason: "Defines test setup." }],
  },
  sourcePr: 1,
  sourceUrl: "https://github.com/example/repo/pull/1",
  prompt: "Implement behavior",
  timeouts: { setupSeconds: 600, agentSeconds: 1200, testsSeconds: 600 },
  resources: { cpus: 2, memoryMb: 4096, storageMb: 10240 },
};

const base = {
  original: definition,
  originalTestPatch: testPatch,
  originalGoldPatch: goldPatch,
  fixedGoldPatch: goldPatch,
};

describe("verifier fix boundaries", () => {
  test("permits environment, test selection, and held-out test edits", () => {
    expect(() =>
      assertVerifierFix({
        ...base,
        fixed: {
          ...definition,
          environment: { ...definition.environment, setupCommand: "npm ci --ignore-scripts" },
        },
        fixedTestPatch: testPatch,
      }),
    ).not.toThrow();
    expect(() =>
      assertVerifierFix({
        ...base,
        fixed: definition,
        fixedTestPatch: testPatch.replace("+test", "+better test"),
      }),
    ).not.toThrow();
    expect(() =>
      assertVerifierFix({
        ...base,
        fixed: { ...definition, passToPass: ["tests/existing.test.ts"] },
        fixedTestPatch: testPatch,
      }),
    ).not.toThrow();
  });

  test("rejects gold, identity, instruction, and out-of-scope test changes", () => {
    expect(() =>
      assertVerifierFix({
        ...base,
        fixed: definition,
        fixedTestPatch: testPatch,
        fixedGoldPatch: goldPatch.replace("= 1", "= 2"),
      }),
    ).toThrow("verifier fix changed the gold patch");
    expect(() =>
      assertVerifierFix({
        ...base,
        fixed: { ...definition, prompt: "Different request" },
        fixedTestPatch: testPatch,
      }),
    ).toThrow("verifier fix changed immutable definition field prompt");
    expect(() =>
      assertVerifierFix({
        ...base,
        fixed: { ...definition, baseCommit: "c".repeat(40) },
        fixedTestPatch: testPatch,
      }),
    ).toThrow("verifier fix changed immutable definition field baseCommit");
    expect(() =>
      assertVerifierFix({
        ...base,
        fixed: definition,
        fixedTestPatch: `${testPatch}${goldPatch}`,
      }),
    ).toThrow("verifier fix changed files outside the held-out tests: src/feature.ts");
    expect(() => assertVerifierFix({ ...base, fixed: definition, fixedTestPatch: "" })).toThrow(
      "empty or invalid held-out test patch",
    );
  });

  test("rejects a fix that changes nothing", () => {
    expect(() =>
      assertVerifierFix({ ...base, fixed: definition, fixedTestPatch: testPatch }),
    ).toThrow("verifier fix left the task unchanged");
  });

  test("applies only permitted fields from a submitted fix", () => {
    const applied = applyVerifierFix(definition, {
      testCommand: "npm run test:unit -- {tests}",
      environment: { ...definition.environment, smokeCommand: "node --version" },
      ...({ prompt: "sneaky" } as Record<string, unknown>),
    });
    expect(applied.testCommand).toBe("npm run test:unit -- {tests}");
    expect(applied.environment.smokeCommand).toBe("node --version");
    expect(applied.prompt).toBe(definition.prompt);
  });
});
