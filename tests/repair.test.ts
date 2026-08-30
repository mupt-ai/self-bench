import { describe, expect, test } from "bun:test";
import { assertRepairedPatchPaths, assertRepairPaths, patchPaths } from "../src/repair.js";

const patch = `diff --git a/tests/a.test.ts b/tests/a.test.ts
index 1111111..2222222 100644
--- a/tests/a.test.ts
+++ b/tests/a.test.ts
@@ -1 +1 @@
-old
+new
diff --git a/tests/b.test.ts b/tests/b.test.ts
new file mode 100644
--- /dev/null
+++ b/tests/b.test.ts
@@ -0,0 +1 @@
+test
`;

describe("test repair boundaries", () => {
  test("extracts the original held-out test paths", () => {
    expect(patchPaths(patch)).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
  });

  test("permits only files already owned by the test patch", () => {
    expect(() => assertRepairPaths(patch, ["tests/b.test.ts"])).not.toThrow();
    expect(() => assertRepairPaths(patch, ["src/product.ts"])).toThrow(
      "repair changed files outside the held-out tests: src/product.ts",
    );
  });

  test("requires the final repaired patch to retain every held-out path", () => {
    expect(() => assertRepairedPatchPaths(patch, patch)).not.toThrow();
    const partial = patch.slice(patch.indexOf("diff --git a/tests/b.test.ts"));
    expect(() => assertRepairedPatchPaths(patch, partial)).toThrow(
      "repair removed held-out test paths: tests/a.test.ts",
    );
  });
});
