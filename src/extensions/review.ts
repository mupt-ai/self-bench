import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function reviewExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "submit_review",
    label: "Submit coupling review",
    description: "Submit the final independent test-coupling verdict exactly once.",
    parameters: Type.Object(
      {
        verdict: Type.Union([Type.Literal("clean"), Type.Literal("coupled")]),
        reason: Type.String({ minLength: 1 }),
        findings: Type.Array(
          Type.Object(
            {
              artifact: Type.String({ minLength: 1 }),
              category: Type.Union([
                Type.Literal("endpoint_path"),
                Type.Literal("field_name"),
                Type.Literal("header_name"),
                Type.Literal("media_type"),
                Type.Literal("other"),
              ]),
              disposition: Type.Union([
                Type.Literal("base_contract"),
                Type.Literal("prompt_contract"),
                Type.Literal("external_contract"),
                Type.Literal("gold_only"),
                Type.Literal("not_contract"),
              ]),
              evidence: Type.String({ minLength: 1 }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
        counterexample: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, input) {
      const output = process.env.SELFBENCH_REVIEW_OUTPUT;
      if (!output) {
        throw new Error("SELFBENCH_REVIEW_OUTPUT is not configured");
      }
      writeFileSync(output, `${JSON.stringify(input, null, 2)}\n`, { flag: "wx" });
      return {
        content: [{ type: "text", text: `Submitted ${input.verdict} verdict.` }],
        details: input,
      };
    },
  });
}
