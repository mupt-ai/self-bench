import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const environmentContract = Type.Object(
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
        { path: Type.String({ minLength: 1 }), reason: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
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
    timeouts: Type.Object(
      {
        setupSeconds: Type.Integer({ minimum: 1 }),
        agentSeconds: Type.Integer({ minimum: 1 }),
        testsSeconds: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    resources: Type.Object(
      {
        cpus: Type.Number({ exclusiveMinimum: 0 }),
        memoryMb: Type.Integer({ minimum: 1 }),
        storageMb: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
    environment: environmentContract,
  },
  { additionalProperties: false },
);

interface CheckVerdict {
  ok: boolean;
  errors: { gate: string; message: string }[];
  renderedDirectory?: string;
}

/** Runs the bundled static check (schema, policy, paths, audit, dry render) over staged files. */
export function runStaticCheck(staging: string, extra: readonly string[] = []): CheckVerdict {
  const program = process.env.SELFBENCH_CHECK_PROGRAM;
  if (!program) {
    throw new Error("SELFBENCH_CHECK_PROGRAM is not configured");
  }
  const result = spawnSync(
    process.execPath,
    [
      program,
      join(staging, "definition.json"),
      join(staging, "test.patch"),
      join(staging, "gold.patch"),
      process.env.SELFBENCH_RENDER_OUTPUT ?? "/work",
      ...extra,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `static check program failed: ${(result.stderr || result.stdout).slice(-4_000)}`,
    );
  }
  return JSON.parse(result.stdout) as CheckVerdict;
}

export function staticCheckFailure(verdict: CheckVerdict): {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError: true;
} {
  const lines = verdict.errors.map((error) => `- [${error.gate}] ${error.message}`).join("\n");
  const rendered = verdict.renderedDirectory
    ? `\nThe dry-rendered Harbor tree (as far as rendering succeeded) is under ${verdict.renderedDirectory}.`
    : "";
  return {
    content: [
      {
        type: "text",
        text: `The submission failed the static check; nothing was recorded. Fix every item and submit again:\n${lines}${rendered}`,
      },
    ],
    details: {},
    isError: true,
  };
}

export default function authoringExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "submit_task",
    label: "Submit SelfBench task",
    description:
      "Submit the complete task at the assigned difficulty: definition (including the environment contract), held-out test patch, and gold patch. The static check (schema, policy, paths, audit, rendering) runs immediately and returns failures for you to fix; a passing submission ends the round.",
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
      const staging = mkdtempSync(join(tmpdir(), "selfbench-submit-"));
      try {
        writeFileSync(join(staging, "definition.json"), `${JSON.stringify(definition, null, 2)}\n`);
        writeFileSync(join(staging, "test.patch"), testPatch);
        writeFileSync(join(staging, "gold.patch"), goldPatch);
        const verdict = runStaticCheck(staging);
        if (!verdict.ok) {
          return staticCheckFailure(verdict);
        }
        const directory = join(root, definition.taskId);
        mkdirSync(root, { recursive: true });
        mkdirSync(directory, { recursive: false });
        cpSync(staging, directory, { recursive: true });
        return {
          content: [
            {
              type: "text",
              text: `Submitted ${definition.taskId}; the static check passed. The exact Harbor tree the worker will build (task.toml, both Dockerfiles, scripts, test.sh) is dry-rendered under ${verdict.renderedDirectory ?? "/work/rendered"}; inspect it if anything looks off, then stop and wait for the verification report.`,
            },
          ],
          details: { taskId: definition.taskId },
        };
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },
  });
}
