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

export const environmentContract = Type.Object(
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

export const taskTimeouts = Type.Object(
  {
    setupSeconds: Type.Integer({ minimum: 1 }),
    agentSeconds: Type.Integer({ minimum: 1 }),
    testsSeconds: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export const taskResources = Type.Object(
  {
    cpus: Type.Number({ exclusiveMinimum: 0 }),
    memoryMb: Type.Integer({ minimum: 1 }),
    storageMb: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

const taskDefinition = Type.Object(
  {
    schemaVersion: Type.Literal(2),
    difficulty: Type.Union([Type.Literal("easy"), Type.Literal("medium"), Type.Literal("hard")]),
    taskId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
    repo: Type.String({ minLength: 1 }),
    baseCommit: Type.String({ pattern: "^[0-9a-fA-F]{40}$" }),
    workdir: Type.String({ minLength: 1 }),
    testCommand: Type.String({ minLength: 1 }),
    failToPass: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    passToPass: Type.Array(Type.String({ minLength: 1 })),
    testPaths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    sourcePr: Type.Integer({ minimum: 1 }),
    sourceUrl: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1 }),
    timeouts: taskTimeouts,
    resources: taskResources,
    environment: environmentContract,
  },
  { additionalProperties: false },
);

export default function authoringExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "submit_task",
    label: "Submit SelfBench task",
    description:
      "Submit the complete task at the assigned difficulty: definition (including the environment contract), held-out test patch, and gold patch. Call it once per round; a resubmission replaces the previous round's task.",
    parameters: Type.Object(
      {
        definition: taskDefinition,
        testPatch: Type.String({ minLength: 1 }),
        goldPatch: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, input) {
      const root = process.env.SELFBENCH_TASK_OUTPUT;
      if (!root) {
        throw new Error("SELFBENCH_TASK_OUTPUT is not configured");
      }
      const { definition, testPatch, goldPatch } = input;
      if (!definition?.taskId || typeof testPatch !== "string" || typeof goldPatch !== "string") {
        throw new Error("submit_task received an incomplete task");
      }
      const directory = join(root, definition.taskId);
      mkdirSync(directory, { recursive: false });
      writeFileSync(
        join(directory, "definition.json"),
        `${JSON.stringify(definition, null, 2)}\n`,
        {
          flag: "wx",
        },
      );
      writeFileSync(join(directory, "test.patch"), testPatch, { flag: "wx" });
      writeFileSync(join(directory, "gold.patch"), goldPatch, { flag: "wx" });
      return {
        content: [
          {
            type: "text",
            text: `Submitted ${definition.taskId}. The worker will compile, audit, build, and verify it; stop here and wait for the report.`,
          },
        ],
        details: { taskId: definition.taskId },
      };
    },
  });
}
