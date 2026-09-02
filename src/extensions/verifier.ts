import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const definitionFix = Type.Object(
  {
    environment: Type.Optional(environmentContract),
    testCommand: Type.Optional(Type.String({ minLength: 1 })),
    failToPass: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    passToPass: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    testPaths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    timeouts: Type.Optional(
      Type.Object(
        {
          setupSeconds: Type.Integer({ minimum: 1 }),
          agentSeconds: Type.Integer({ minimum: 1 }),
          testsSeconds: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
    resources: Type.Optional(
      Type.Object(
        {
          cpus: Type.Number({ exclusiveMinimum: 0 }),
          memoryMb: Type.Integer({ minimum: 1 }),
          storageMb: Type.Integer({ minimum: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

const FIX_FIELDS = [
  "environment",
  "testCommand",
  "failToPass",
  "passToPass",
  "testPaths",
  "timeouts",
  "resources",
] as const;

interface CheckVerdict {
  ok: boolean;
  errors: { gate: string; message: string }[];
  renderedDirectory?: string;
}

// Duplicated from src/extensions/authoring.ts: pi loads each extension file standalone.
function runStaticCheck(staging: string, extra: readonly string[]): CheckVerdict {
  const program = requiredEnvironment("SELFBENCH_CHECK_PROGRAM");
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

function staticCheckFailure(verdict: CheckVerdict): {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError: true;
} {
  const lines = verdict.errors.map((error) => `- [${error.gate}] ${error.message}`).join("\n");
  return {
    content: [
      {
        type: "text",
        text: `The fix failed the static check; nothing was recorded. Fix every item and submit again:\n${lines}`,
      },
    ],
    details: {},
    isError: true,
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

function writeVerdict(verdict: Record<string, unknown>): void {
  const root = requiredEnvironment("SELFBENCH_VERDICT_OUTPUT");
  mkdirSync(root, { recursive: true });
  const path = join(root, "verdict.json");
  if (existsSync(path)) {
    throw new Error("a verdict was already submitted this round");
  }
  writeFileSync(path, `${JSON.stringify(verdict, null, 2)}\n`, { flag: "wx" });
}

function workingTreePatch(repository: string): string {
  for (const args of [
    ["add", "-N", "--all"],
    ["diff", "--binary", "HEAD"],
  ]) {
    const result = spawnSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr.slice(-2_000)}`);
    }
    if (args[0] === "diff") {
      return result.stdout;
    }
  }
  return "";
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
      writeVerdict({ kind: "accepted", ...input });
      return { content: [{ type: "text", text: "Recorded the acceptance verdict." }], details: {} };
    },
  });
  pi.registerTool({
    name: "submit_fix",
    label: "Submit SelfBench fix",
    description:
      "Submit a fix: edit held-out test files in the working tree first, then call this once with a summary and any environment contract or test-selection changes. The static check runs immediately and returns failures for you to fix; a passing fix ends the round. The gold patch, base commit, and instruction cannot change.",
    parameters: Type.Object(
      { summary: Type.String({ minLength: 1 }), definition: definitionFix },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, input) {
      const taskDirectory = requiredEnvironment("SELFBENCH_TASK_DIRECTORY");
      const repository = requiredEnvironment("SELFBENCH_REPO_DIRECTORY");
      const fixOutput = requiredEnvironment("SELFBENCH_FIX_OUTPUT");
      const original = JSON.parse(
        readFileSync(join(taskDirectory, "definition.json"), "utf8"),
      ) as Record<string, unknown>;
      const fixed: Record<string, unknown> = { ...original };
      for (const field of FIX_FIELDS) {
        const value = (input.definition as Record<string, unknown> | undefined)?.[field];
        if (value !== undefined) {
          fixed[field] = value;
        }
      }
      const staging = mkdtempSync(join(tmpdir(), "selfbench-fix-"));
      try {
        writeFileSync(join(staging, "definition.json"), `${JSON.stringify(fixed, null, 2)}\n`);
        writeFileSync(join(staging, "test.patch"), workingTreePatch(repository));
        cpSync(join(taskDirectory, "solution/gold.patch"), join(staging, "gold.patch"));
        const verdict = runStaticCheck(staging, [
          join(taskDirectory, "definition.json"),
          join(taskDirectory, "tests/test.patch"),
          join(taskDirectory, "solution/gold.patch"),
        ]);
        if (!verdict.ok) {
          return staticCheckFailure(verdict);
        }
        mkdirSync(fixOutput, { recursive: true });
        cpSync(join(staging, "definition.json"), join(fixOutput, "fixed-definition.json"));
        cpSync(join(staging, "test.patch"), join(fixOutput, "fixed-test.patch"));
        writeVerdict({ kind: "fixed", summary: input.summary, definition: input.definition ?? {} });
        return {
          content: [
            {
              type: "text",
              text: `Recorded the fix; the static check passed and the fixed Harbor tree is dry-rendered under ${verdict.renderedDirectory ?? "/work/rendered"}. The worker will rebuild and re-verify the task; stop here and wait for the report.`,
            },
          ],
          details: {},
        };
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },
  });
}
