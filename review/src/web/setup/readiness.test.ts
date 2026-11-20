import { expect, test } from "bun:test";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { setupCoverage } from "./readiness";

const credential = (kind: CredentialInfo["kind"], auth: CredentialInfo["auth"] = "api-key") => ({
  kind,
  auth,
});

/** A Dari connection serving these Dari ids, as its grant lists them. */
const dari = (...ids: { id: string; only?: "claude-code" | "muse-code" }[]) => ({
  kind: "dari-link" as const,
  auth: "dari-link" as const,
  linkModels: { models: ids, prefixes: [] },
});

test("setup coverage follows what generation and evaluation each accept", () => {
  const cases: [string, ReturnType<typeof credential>[], object, string][] = [
    ["nothing", [], {}, "generate -- evaluate --"],
    // A Claude plan serves only Claude Code, which generation never runs: it only evaluates.
    [
      "Claude plan via Dari and E2B",
      [dari({ id: "anthropic/claude-sonnet-5-5", only: "claude-code" }), credential("e2b")],
      {},
      "generate -s evaluate ms",
    ],
    // Generation runs Pi, which any model a ChatGPT or OpenCode Go plan serves can run.
    [
      "ChatGPT plan via Dari and E2B",
      [dari({ id: "openai/gpt-6-astra" }), credential("e2b")],
      {},
      "generate ms evaluate ms",
    ],
    [
      "OpenCode Go plan via Dari and Modal",
      [dari({ id: "opencode-go/glm-5.3" }), credential("modal")],
      {},
      "generate ms evaluate ms",
    ],
    [
      "Muse plan via Dari and E2B",
      [dari({ id: "meta/muse-spark-1.3", only: "muse-code" }), credential("e2b")],
      {},
      "generate -s evaluate ms",
    ],
    [
      "Anthropic key and Daytona",
      [credential("anthropic"), credential("daytona")],
      {},
      "generate ms evaluate ms",
    ],
    [
      "OpenRouter key and Vercel",
      [credential("openrouter"), credential("vercel")],
      {},
      "generate ms evaluate ms",
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
