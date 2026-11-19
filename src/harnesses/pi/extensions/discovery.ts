import { readFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA = "^[0-9a-fA-F]{40}$";

/**
 * Discovery's two hand-offs: `submit_discovery` for merged PRs, `submit_features` for features
 * built over several. A shard enables only the one its batch needs.
 */
export default function discoveryExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "submit_features",
    label: "Submit SelfBench features",
    description: "Submit the final list of features, each with its merged PRs, exactly once.",
    parameters: Type.Object(
      {
        features: Type.Array(
          Type.Object(
            {
              candidateId: Type.String({ pattern: CANDIDATE_ID.source }),
              difficulty: Type.Union([
                Type.Literal("easy"),
                Type.Literal("medium"),
                Type.Literal("hard"),
              ]),
              title: Type.String({ minLength: 1, maxLength: 120 }),
              summary: Type.String({ minLength: 1, maxLength: 8000 }),
              pullRequests: Type.Array(
                Type.Object(
                  {
                    number: Type.Integer({ minimum: 1 }),
                    url: Type.String({ minLength: 1 }),
                    title: Type.String({ minLength: 1 }),
                    mergeCommit: Type.String({ pattern: SHA }),
                  },
                  { additionalProperties: false },
                ),
                { minItems: 1, maxItems: 25 },
              ),
              baseCommit: Type.String({ pattern: SHA }),
              completedCommit: Type.String({ pattern: SHA }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 50 },
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, input) {
      const output = requiredPath("SELFBENCH_DISCOVERY_OUTPUT");
      const features = input.features;
      if (!features) throw new Error("submit_features received no features");
      for (const feature of features) {
        if (!feature.candidateId || !CANDIDATE_ID.test(feature.candidateId)) {
          throw new Error(
            "candidateId must start with a letter or digit and contain only letters, digits, dots, underscores, or hyphens",
          );
        }
      }
      const excluded = new Set<number>(
        JSON.parse(readFileSync(requiredPath("SELFBENCH_DISCOVERY_EXCLUSIONS"), "utf8")),
      );
      const accepted = features.filter(
        (feature) =>
          !(feature.pullRequests ?? []).some(
            (pr) => pr.number !== undefined && excluded.has(pr.number),
          ),
      );
      writeFileSync(output, `${JSON.stringify({ features: accepted }, null, 2)}\n`, { flag: "wx" });
      return {
        content: [{ type: "text", text: `Submitted ${accepted.length} new features.` }],
        details: { features: accepted },
      };
    },
  });
  pi.registerTool({
    name: "submit_discovery",
    label: "Submit SelfBench discovery",
    description: "Submit the final ranked tiered candidate list exactly once.",
    parameters: Type.Object(
      {
        candidates: Type.Array(
          Type.Object(
            {
              candidateId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
              difficulty: Type.Union([
                Type.Literal("easy"),
                Type.Literal("medium"),
                Type.Literal("hard"),
              ]),
              sourcePr: Type.Integer({ minimum: 1 }),
              sourceUrl: Type.String({ minLength: 1 }),
              baseCommit: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
              completedCommit: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
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
      for (const candidate of candidates) {
        if (!candidate.candidateId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate.candidateId)) {
          throw new Error(
            "candidateId must start with a letter or digit and contain only letters, digits, dots, underscores, or hyphens",
          );
        }
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

function requiredPath(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}
