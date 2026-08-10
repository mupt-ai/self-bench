import { describe, expect, test } from "bun:test";
import type { TaskDefinition } from "../src/contracts.js";
import { assertValidationRepair } from "../src/validation-repair.js";

const patch = `diff --git a/tests/behavior.test.ts b/tests/behavior.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/behavior.test.ts
@@ -0,0 +1 @@
+test
`;

const definition: TaskDefinition = {
  schemaVersion: 1,
  difficulty: "easy",
  taskId: "task",
  repo: "example/repo",
  baseCommit: "a".repeat(40),
  workdir: ".",
  setupCommand: "npm ci",
  testCommand: "npm test -- {tests}",
  failToPass: ["tests/behavior.test.ts"],
  passToPass: [],
  testPaths: ["tests/behavior.test.ts"],
  toolchains: ["node"],
  sourcePr: 1,
  sourceUrl: "https://github.com/example/repo/pull/1",
  prompt: "Implement behavior",
  timeouts: { setupSeconds: 600, agentSeconds: 1200, testsSeconds: 600 },
  resources: { cpus: 2, memoryMb: 4096, storageMb: 10240 },
};

describe("validation repair boundaries", () => {
  test("permits command changes and held-out test edits", () => {
    expect(() =>
      assertValidationRepair(
        definition,
        { ...definition, testCommand: "npm run test:focused -- {tests}" },
        patch,
        ["tests/behavior.test.ts"],
      ),
    ).not.toThrow();
  });

  test("rejects identity and product-code changes", () => {
    expect(() =>
      assertValidationRepair(definition, { ...definition, prompt: "A different request" }, patch, [
        "tests/behavior.test.ts",
      ]),
    ).toThrow("validation repair changed immutable definition field prompt");
    expect(() => assertValidationRepair(definition, definition, patch, ["src/product.ts"])).toThrow(
      "validation repair changed files outside held-out tests: src/product.ts",
    );
  });

  test("rejects an authored patch containing undeclared product paths", () => {
    const productPatch = patch.replaceAll("tests/behavior.test.ts", "src/product.ts");
    expect(() => assertValidationRepair(definition, definition, productPatch, [])).toThrow(
      "validation repair requires test-only patch paths: src/product.ts",
    );
  });

  test("permits selecting existing pass-to-pass tests without editing them", () => {
    expect(() =>
      assertValidationRepair(
        definition,
        { ...definition, passToPass: ["tests/existing.test.ts"] },
        patch,
        [],
      ),
    ).not.toThrow();
  });
});
