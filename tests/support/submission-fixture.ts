import type { Submission } from "../../src/generation/task/submission.js";

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

/** An easy task that passes every static check. */
export const submission: Submission = {
  "instruction.md": "Implement the feature.\n",
  Dockerfile:
    "FROM oven/bun:1\nADD repo.tar.gz /app/\nWORKDIR /app\nRUN bun install --frozen-lockfile\n",
  "smoke.sh": "bun --version\n",
  "run-tests.sh":
    'case "$1" in\n  fail-to-pass) bun test tests/feature.test.ts ;;\n  pass-to-pass) bun test tests/existing.test.ts ;;\nesac\n',
  "test.patch": testPatch,
  "gold.patch": goldPatch,
  "services.sh": "",
};
