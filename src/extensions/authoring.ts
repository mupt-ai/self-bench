import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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
    timeouts: Type.Object({
      setupSeconds: Type.Integer({ minimum: 1 }),
      agentSeconds: Type.Integer({ minimum: 1 }),
      testsSeconds: Type.Integer({ minimum: 1 }),
    }),
    resources: Type.Object({
      cpus: Type.Number({ exclusiveMinimum: 0 }),
      memoryMb: Type.Integer({ minimum: 1 }),
      storageMb: Type.Integer({ minimum: 1 }),
    }),
  },
  { additionalProperties: false },
);

export default function authoringExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "submit_task",
    label: "Submit SelfBench task",
    description: "Submit exactly one complete task at the assigned difficulty.",
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
        content: [{ type: "text", text: `Submitted ${definition.taskId}.` }],
        details: { taskId: definition.taskId },
      };
    },
  });
}
