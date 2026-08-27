import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const environmentVariableName = Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" });
const environmentVariables = Type.Record(environmentVariableName, Type.String());

const service = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9_-]*$" }),
    image: Type.String({ minLength: 1 }),
    environmentVariables,
    command: Type.Optional(Type.Array(Type.String())),
    healthcheck: Type.Object(
      {
        test: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        intervalSeconds: Type.Integer({ minimum: 1 }),
        timeoutSeconds: Type.Integer({ minimum: 1 }),
        retries: Type.Integer({ minimum: 1 }),
        startPeriodSeconds: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const environment = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    baseImage: Type.String({ minLength: 1 }),
    rootSetupCommand: Type.String({ minLength: 1 }),
    setupCommand: Type.String({ minLength: 1 }),
    smokeCommand: Type.String({ minLength: 1 }),
    environmentVariables,
    services: Type.Array(service),
    source: Type.Union([
      Type.Literal("repository-dockerfile"),
      Type.Literal("devcontainer"),
      Type.Literal("ci-adapted"),
      Type.Literal("generated"),
    ]),
    evidence: Type.Array(
      Type.Object(
        {
          path: Type.String({ minLength: 1 }),
          reason: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

export default function environmentExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "submit_environment",
    label: "Submit SelfBench environment",
    description: "Submit exactly one complete repository-native environment contract.",
    parameters: Type.Object({ environment }, { additionalProperties: false }),
    async execute(_toolCallId, input) {
      const root = process.env.SELFBENCH_ENVIRONMENT_OUTPUT;
      if (!root) {
        throw new Error("SELFBENCH_ENVIRONMENT_OUTPUT is not configured");
      }
      mkdirSync(root, { recursive: true });
      const output = join(root, "environment.json");
      writeFileSync(output, `${JSON.stringify(input.environment, null, 2)}\n`, { flag: "wx" });
      return {
        content: [{ type: "text", text: "Submitted the environment contract." }],
        details: { output },
      };
    },
  });
}
