import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { environmentContract, taskResources, taskTimeouts } from "./authoring.js";

const definitionFix = Type.Object(
  {
    environment: Type.Optional(environmentContract),
    testCommand: Type.Optional(Type.String({ minLength: 1 })),
    failToPass: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    passToPass: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    testPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    timeouts: Type.Optional(taskTimeouts),
    resources: Type.Optional(taskResources),
  },
  { additionalProperties: false },
);

function verdictDirectory(): string {
  const root = process.env.SELFBENCH_VERDICT_OUTPUT;
  if (!root) {
    throw new Error("SELFBENCH_VERDICT_OUTPUT is not configured");
  }
  mkdirSync(root, { recursive: true });
  for (const existing of ["accept.json", "fix.json"]) {
    if (existsSync(join(root, existing))) {
      throw new Error(`a verdict was already submitted this round (${existing})`);
    }
  }
  return root;
}

export default function verifierExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "accept_task",
    label: "Accept SelfBench task",
    description:
      "Accept the task as a fair, self-contained benchmark. Only valid when the latest verification report is GREEN.",
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
      const root = verdictDirectory();
      writeFileSync(join(root, "accept.json"), `${JSON.stringify(input, null, 2)}\n`, {
        flag: "wx",
      });
      return {
        content: [{ type: "text", text: "Recorded the acceptance verdict." }],
        details: {},
      };
    },
  });
  pi.registerTool({
    name: "submit_fix",
    label: "Submit SelfBench fix",
    description:
      "Submit a fix: edit held-out test files in the working tree first, then call this once with any environment contract or test-selection changes. The gold patch, base commit, and instruction cannot change.",
    parameters: Type.Object(
      {
        summary: Type.String({ minLength: 1 }),
        definition: definitionFix,
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, input) {
      const root = verdictDirectory();
      writeFileSync(join(root, "fix.json"), `${JSON.stringify(input, null, 2)}\n`, {
        flag: "wx",
      });
      return {
        content: [
          {
            type: "text",
            text: "Recorded the fix. The worker will rebuild and re-verify the task; stop here and wait for the report.",
          },
        ],
        details: {},
      };
    },
  });
}
