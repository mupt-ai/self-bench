import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function discoveryExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "submit_discovery",
    label: "Submit SelfBench discovery",
    description: "Submit the final ranked tiered candidate list exactly once.",
    parameters: Type.Object(
      {
        candidates: Type.Array(
          Type.Object(
            {
              candidateId: Type.String({ minLength: 1 }),
              difficulty: Type.Union([
                Type.Literal("easy"),
                Type.Literal("medium"),
                Type.Literal("hard"),
              ]),
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
      const exclusionsPath = process.env.SELFBENCH_DISCOVERY_EXCLUSIONS;
      if (!exclusionsPath) {
        throw new Error("SELFBENCH_DISCOVERY_EXCLUSIONS is not configured");
      }
      const excluded = new Set<number>(JSON.parse(readFileSync(exclusionsPath, "utf8")));
      const accepted = candidates.filter(
        ({ sourcePr }) => sourcePr !== undefined && !excluded.has(sourcePr),
      );
      writeFileSync(output, `${JSON.stringify({ candidates: accepted }, null, 2)}\n`, {
        flag: "wx",
      });
      return {
        content: [{ type: "text", text: `Submitted ${accepted.length} new candidates.` }],
        details: { candidates: accepted },
      };
    },
  });
}
