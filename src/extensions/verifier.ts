import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { VerifyClient, verifyOutcomeText } from "./shared/mailbox.js";
import { definitionFix, FIX_FIELDS } from "./shared/schemas.js";
import {
  requiredEnvironment,
  runStaticCheck,
  type StagedSubmission,
  stageSubmission,
  staticCheckFailure,
  type ToolFailure,
} from "./shared/static-check.js";

const fixSubmission = Type.Object(
  { summary: Type.String({ minLength: 1 }), definition: definitionFix },
  { additionalProperties: false },
);

interface FixPayload {
  readonly definition: Record<string, unknown>;
  readonly testPatch: string;
  readonly goldPatch: string;
  readonly original: { definition: string; testPatch: string; goldPatch: string };
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

/** Composes the fixed task from the round's original task plus the agent's edits. */
function composeFix(fix: Record<string, unknown> | undefined): FixPayload {
  const taskDirectory = requiredEnvironment("SELFBENCH_TASK_DIRECTORY");
  const repository = requiredEnvironment("SELFBENCH_REPO_DIRECTORY");
  const originalDefinition = join(taskDirectory, "definition.json");
  const originalTestPatch = join(taskDirectory, "tests/test.patch");
  const goldPatchPath = join(taskDirectory, "solution/gold.patch");
  const definition = JSON.parse(readFileSync(originalDefinition, "utf8")) as Record<
    string,
    unknown
  >;
  for (const field of FIX_FIELDS) {
    const value = fix?.[field];
    if (value !== undefined) {
      definition[field] = value;
    }
  }
  return {
    definition,
    testPatch: workingTreePatch(repository),
    goldPatch: readFileSync(goldPatchPath, "utf8"),
    original: {
      definition: originalDefinition,
      testPatch: originalTestPatch,
      goldPatch: goldPatchPath,
    },
  };
}

function checkFix(
  payload: FixPayload,
): { verdict: ReturnType<typeof runStaticCheck>; staging: StagedSubmission } | ToolFailure {
  const staging = stageSubmission(
    payload.definition,
    payload.testPatch,
    payload.goldPatch,
    "selfbench-fix-",
  );
  try {
    const verdict = runStaticCheck(staging.directory, [
      payload.original.definition,
      payload.original.testPatch,
      payload.original.goldPatch,
    ]);
    if (!verdict.ok) {
      staging.dispose();
      return staticCheckFailure(verdict, "fix");
    }
    return { verdict, staging };
  } catch (error) {
    staging.dispose();
    throw error;
  }
}

export default function verifierExtension(pi: ExtensionAPI): void {
  const client = new VerifyClient();

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
    name: "verify",
    label: "Verify SelfBench fix",
    description:
      "Run the harness's real verification on your current fix (held-out test edits in the working tree plus any definition changes) without submitting: static check, compile, audit, build, smoke, nop, oracle. Blocks until the report is back. Budget-limited per session.",
    parameters: Type.Object({ definition: definitionFix }, { additionalProperties: false }),
    async execute(_toolCallId, input) {
      const payload = composeFix(input.definition as Record<string, unknown> | undefined);
      const checked = checkFix(payload);
      if ("isError" in checked) {
        return checked;
      }
      checked.staging.dispose();
      const outcome = await client.verify("fix", payload);
      return {
        content: [{ type: "text", text: verifyOutcomeText(outcome, "submit_fix") }],
        details: { kind: outcome.kind, remaining: client.remaining },
        ...(outcome.kind === "exhausted" ? { isError: true } : {}),
      };
    },
  });

  pi.registerTool({
    name: "submit_fix",
    label: "Submit SelfBench fix",
    description:
      "Submit a fix: edit held-out test files in the working tree first, then call this once with a summary and any environment contract or test-selection changes. Run verify first; the static check runs again here and a passing fix ends the session. The gold patch, base commit, and instruction cannot change.",
    parameters: fixSubmission,
    async execute(_toolCallId, input) {
      const fixOutput = requiredEnvironment("SELFBENCH_FIX_OUTPUT");
      const payload = composeFix(input.definition as Record<string, unknown> | undefined);
      const checked = checkFix(payload);
      if ("isError" in checked) {
        return checked;
      }
      mkdirSync(fixOutput, { recursive: true });
      cpSync(
        join(checked.staging.directory, "definition.json"),
        join(fixOutput, "fixed-definition.json"),
      );
      cpSync(join(checked.staging.directory, "test.patch"), join(fixOutput, "fixed-test.patch"));
      checked.staging.dispose();
      const verified = client.verifiedGreen(payload);
      writeVerdict({ kind: "fixed", summary: input.summary, definition: input.definition ?? {} });
      return {
        content: [
          {
            type: "text",
            text: `Recorded the fix; the static check passed and the fixed Harbor tree is dry-rendered under ${checked.verdict.renderedDirectory ?? "/work/rendered"}. ${verified ? "This fix matches your last green verify, so the worker reuses that report." : "This fix was not verified green in this session, so the worker verifies it now."} Stop here and wait.`,
          },
        ],
        details: { verified },
      };
    },
  });
}
