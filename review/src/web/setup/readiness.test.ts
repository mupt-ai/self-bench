import { expect, test } from "bun:test";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { setupCoverage } from "./readiness";

const credential = (kind: CredentialInfo["kind"], auth: CredentialInfo["auth"] = "api-key") => ({
  kind,
  auth,
});

test("setup coverage follows what generation and evaluation each accept", () => {
  const cases: [string, ReturnType<typeof credential>[], object, string][] = [
    ["nothing", [], {}, "generate -- evaluate --"],
    [
      "ChatGPT sign-in and Modal",
      [credential("openai", "codex-login"), credential("modal")],
      {},
      "generate ms evaluate ms",
    ],
    // Generation authors in Pi, so a Claude Code sign-in only runs evaluations.
    [
      "Claude sign-in and E2B",
      [credential("anthropic", "claude-login"), credential("e2b")],
      {},
      "generate -s evaluate ms",
    ],
    [
      "Anthropic key and Daytona",
      [credential("anthropic"), credential("daytona")],
      {},
      "generate m- evaluate ms",
    ],
    [
      "OpenRouter key and Vercel",
      [credential("openrouter"), credential("vercel")],
      {},
      "generate ms evaluate m-",
    ],
    ["custom endpoint", [credential("custom")], {}, "generate -- evaluate m-"],
    ["managed access", [], { models: true, sandbox: true }, "generate ms evaluate ms"],
  ];
  for (const [name, credentials, managed, expected] of cases) {
    const { generate, evaluate } = setupCoverage(credentials, managed);
    const mark = (coverage: { model: boolean; sandbox: boolean }) =>
      `${coverage.model ? "m" : "-"}${coverage.sandbox ? "s" : "-"}`;
    expect(`generate ${mark(generate)} evaluate ${mark(evaluate)}`, name).toBe(expected);
  }
});
