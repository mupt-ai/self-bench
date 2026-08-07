import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function discoveryExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "submit_discovery",
    label: "Submit SelfBench discovery",
    description: "Submit the final ranked hard-mode candidate list exactly once.",
    parameters: Type.Object(
      {
        candidates: Type.Array(
          Type.Object(
            {
              candidateId: Type.String({ minLength: 1 }),
              sourcePr: Type.Integer({ minimum: 1 }),
              sourceUrl: Type.String({ minLength: 1 }),
              baseCommit: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
              completedCommit: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
              request: Type.String({ minLength: 1 }),
              provenance: Type.Object({
                sourceType: Type.Union([
                  Type.Literal("pi"),
                  Type.Literal("claude-code"),
                  Type.Literal("codex"),
                  Type.Literal("generic"),
                  Type.Literal("github-pull-request"),
                ]),
                sessionId: Type.String({ minLength: 1 }),
                messageIndex: Type.Integer({ minimum: 0 }),
              }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 100 },
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, input) {
      const output = process.env.SELFBENCH_DISCOVERY_OUTPUT;
      if (!output) {
        throw new Error("SELFBENCH_DISCOVERY_OUTPUT is not configured");
      }
      const candidates = input.candidates;
      if (!candidates) {
        throw new Error("submit_discovery received no candidates");
      }
      writeFileSync(output, `${JSON.stringify({ candidates }, null, 2)}\n`, { flag: "wx" });
      return {
        content: [{ type: "text", text: `Submitted ${candidates.length} candidates.` }],
        details: { candidates },
      };
    },
  });
}
