import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

function writeVerdict(verdict: Record<string, unknown>): void {
  const root = requiredEnvironment("SELFBENCH_VERDICT_OUTPUT");
  mkdirSync(root, { recursive: true });
  const path = join(root, "verdict.json");
  if (existsSync(path)) throw new Error("a verdict was already submitted this round");
  writeFileSync(path, `${JSON.stringify(verdict, null, 2)}\n`, { flag: "wx" });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** The verifier is intentionally read-only: it can accept or advise the next authoring round. */
export default function verifierExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "accept_task",
    label: "Accept SelfBench task",
    description: "Accept a fair task after the latest report is GREEN.",
    parameters: Type.Object(
      {
        reason: Type.String({ minLength: 1 }),
        findings: Type.Array(
          Type.Object(
            {
              artifact: Type.String({ minLength: 1 }),
              disposition: Type.Union([
                Type.Literal("base_contract"),
                Type.Literal("prompt_contract"),
                Type.Literal("external_contract"),
                Type.Literal("not_contract"),
              ]),
              evidence: Type.String({ minLength: 1 }),
            },
            { additionalProperties: false },
          ),
        ),
        counterexample: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, input) {
      writeVerdict({ kind: "accepted", ...input });
      return { content: [{ type: "text", text: "Recorded the acceptance verdict." }], details: {} };
    },
  });

  pi.registerTool({
    name: "submit_suggestions",
    label: "Submit authoring suggestions",
    description:
      "Submit concise, actionable suggestions for the next authoring agent. This verifier is read-only and must not edit task files.",
    parameters: Type.Object(
      {
        summary: Type.String({ minLength: 1 }),
        suggestions: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, input) {
      writeVerdict({ kind: "suggestions", ...input });
      return {
        content: [{ type: "text", text: "Recorded suggestions for the next authoring round." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "reject_task",
    label: "Reject SelfBench task",
    description: "Reject a task that cannot be made fair within the authoring workflow.",
    parameters: Type.Object(
      { reason: Type.String({ minLength: 1 }) },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, input) {
      writeVerdict({ kind: "rejected", ...input });
      return { content: [{ type: "text", text: "Recorded the rejection verdict." }], details: {} };
    },
  });
}
