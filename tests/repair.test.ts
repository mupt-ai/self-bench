import { describe, expect, test } from "bun:test";
import { patchPaths } from "../src/lib/patch-paths.js";

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

describe("patch path parsing", () => {
  test("extracts the original held-out test paths", () => {
    expect(patchPaths(patch)).toEqual(["tests/a.test.ts", "tests/b.test.ts"]);
  });
});
