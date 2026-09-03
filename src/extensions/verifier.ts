import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type FixDeliverable, loadFixDeliverable } from "./shared/deliverable.js";
import { VerifyClient, verifyOutcomeText } from "./shared/mailbox.js";
import {
  requiredEnvironment,
  runStaticCheck,
  type StagedSubmission,
  stageSubmission,
  staticCheckFailure,
  type ToolFailure,
} from "./shared/static-check.js";

const noArguments = Type.Object({}, { additionalProperties: false });

function writeVerdict(verdict: Record<string, unknown>): void {
  const root = requiredEnvironment("SELFBENCH_VERDICT_OUTPUT");
  mkdirSync(root, { recursive: true });
  const path = join(root, "verdict.json");
  if (existsSync(path)) {
    throw new Error("a verdict was already submitted this round");
  }
  writeFileSync(path, `${JSON.stringify(verdict, null, 2)}\n`, { flag: "wx" });
}

function loadFix(): FixDeliverable | ToolFailure {
  return loadFixDeliverable(
    requiredEnvironment("SELFBENCH_FIX_OUTPUT"),
    requiredEnvironment("SELFBENCH_TASK_DIRECTORY"),
    requiredEnvironment("SELFBENCH_REPO_DIRECTORY"),
  );
}

function checkFix(
  payload: FixDeliverable,
): { verdict: ReturnType<typeof runStaticCheck>; staging: StagedSubmission } | ToolFailure {
  const staging = stageSubmission(
    payload.definition,
    payload.testPatch,
    payload.goldPatch,
    "selfbench-fix-",
  );
  try {
    // /work/repo is the compiled task's snapshot with the held-out patch applied to its working
    // tree; HEAD is the clean base commit the patches must apply to.
    const verdict = runStaticCheck(
      staging.directory,
      [payload.original.definition, payload.original.testPatch, payload.original.goldPatch],
      { base: "HEAD" },
    );
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
      "Takes no arguments. Reads your fix from /work/fix (optional definition.json with changed environment/test-selection fields; test.patch, or the /work/repo working tree diff when absent), runs the static check, then the harness's real verification. Blocks until the report is back. Budget-limited per session.",
    parameters: noArguments,
    async execute() {
      const payload = loadFix();
      if ("isError" in payload) {
        return payload;
      }
      const checked = checkFix(payload);
      if ("isError" in checked) {
        return checked;
      }
      checked.staging.dispose();
      const outcome = await client.verify("fix", payload);
      return {
        content: [{ type: "text", text: verifyOutcomeText(outcome, "submit_fix") }],
        details: {
          kind: outcome.kind,
          remaining: client.remaining,
          testPatchSource: payload.testPatchSource,
        },
        ...(outcome.kind === "exhausted" ? { isError: true } : {}),
      };
    },
  });

  pi.registerTool({
    name: "submit_fix",
    label: "Submit SelfBench fix",
    description:
      "Takes no arguments. Reads your fix from /work/fix (same files as verify), runs the static check, and records it; a passing fix ends the session. Run verify first. The gold patch, base commit, and instruction cannot change.",
    parameters: noArguments,
    async execute() {
      const fixOutput = requiredEnvironment("SELFBENCH_FIX_OUTPUT");
      const payload = loadFix();
      if ("isError" in payload) {
        return payload;
      }
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
      writeVerdict({
        kind: "fixed",
        summary: `fix from ${fixOutput} (test patch from ${payload.testPatchSource})`,
      });
      return {
        content: [
          {
            type: "text",
            text: `Recorded the fix; the static check passed and the fixed Harbor tree is dry-rendered under ${checked.verdict.renderedDirectory ?? "/work/rendered"}. ${verified ? "This fix matches your last green verify, so the worker reuses that report." : "This fix was not verified green in this session, so the worker verifies it now."} Stop here and wait.`,
          },
        ],
        details: { verified, testPatchSource: payload.testPatchSource },
      };
    },
  });
}
