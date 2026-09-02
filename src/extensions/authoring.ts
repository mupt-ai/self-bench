import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { VerifyClient, verifyOutcomeText } from "./shared/mailbox.js";
import { taskSubmission } from "./shared/schemas.js";
import {
  failure,
  requiredEnvironment,
  runStaticCheck,
  stageSubmission,
  staticCheckFailure,
} from "./shared/static-check.js";

export default function authoringExtension(pi: ExtensionAPI): void {
  const client = new VerifyClient();

  pi.registerTool({
    name: "verify",
    label: "Verify SelfBench task",
    description:
      "Run the harness's real verification on your complete task without submitting: static check, trusted compile, audit, image build, smoke, nop, and oracle. Blocks until the report is back (can take up to an hour). Budget-limited per session; the result says how many calls remain.",
    parameters: taskSubmission,
    async execute(_toolCallId, input) {
      const { definition, testPatch, goldPatch } = input;
      if (!definition?.taskId || typeof testPatch !== "string" || typeof goldPatch !== "string") {
        return failure("verify received an incomplete task");
      }
      const staging = stageSubmission(definition, testPatch, goldPatch, "selfbench-verify-");
      try {
        const verdict = runStaticCheck(staging.directory);
        if (!verdict.ok) {
          return staticCheckFailure(verdict, "task");
        }
      } finally {
        staging.dispose();
      }
      const outcome = await client.verify("task", { definition, testPatch, goldPatch });
      return {
        content: [{ type: "text", text: verifyOutcomeText(outcome, "submit_task") }],
        details: { kind: outcome.kind, remaining: client.remaining },
        ...(outcome.kind === "exhausted" ? { isError: true } : {}),
      };
    },
  });

  pi.registerTool({
    name: "submit_task",
    label: "Submit SelfBench task",
    description:
      "Submit the complete task at the assigned difficulty: definition (including the environment contract), held-out test patch, and gold patch. Run verify first; submit the payload verify reported green. The static check runs again here and a passing submission ends the session.",
    parameters: taskSubmission,
    async execute(_toolCallId, input) {
      const root = requiredEnvironment("SELFBENCH_TASK_OUTPUT");
      const { definition, testPatch, goldPatch } = input;
      if (!definition?.taskId || typeof testPatch !== "string" || typeof goldPatch !== "string") {
        return failure("submit_task received an incomplete task");
      }
      const staging = stageSubmission(definition, testPatch, goldPatch);
      try {
        const verdict = runStaticCheck(staging.directory);
        if (!verdict.ok) {
          return staticCheckFailure(verdict, "submission");
        }
        const directory = join(root, definition.taskId);
        mkdirSync(root, { recursive: true });
        mkdirSync(directory, { recursive: false });
        cpSync(staging.directory, directory, { recursive: true });
        const verified = client.verifiedGreen({ definition, testPatch, goldPatch });
        return {
          content: [
            {
              type: "text",
              text: `Submitted ${definition.taskId}; the static check passed and the Harbor tree is dry-rendered under ${verdict.renderedDirectory ?? "/work/rendered"}. ${verified ? "This payload matches your last green verify, so the worker reuses that report." : "This payload was not verified green in this session, so the worker verifies it now and a round is spent if it fails."} Stop here and wait.`,
            },
          ],
          details: { taskId: definition.taskId, verified },
        };
      } finally {
        staging.dispose();
      }
    },
  });
}
