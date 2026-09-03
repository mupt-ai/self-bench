import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadTaskDeliverable } from "./shared/deliverable.js";
import { VerifyClient, verifyOutcomeText } from "./shared/mailbox.js";
import {
  requiredEnvironment,
  runStaticCheck,
  stageSubmission,
  staticCheckFailure,
} from "./shared/static-check.js";

const noArguments = Type.Object({}, { additionalProperties: false });

export default function authoringExtension(pi: ExtensionAPI): void {
  const client = new VerifyClient();
  const deliverable = (): string => process.env.SELFBENCH_DELIVERABLE ?? "/work/task";

  pi.registerTool({
    name: "verify",
    label: "Verify SelfBench task",
    description:
      "Takes no arguments. Reads the deliverable in /work/task (definition.json, instruction.md, test.patch, gold.patch), runs the static check, then the harness's real verification: trusted compile, audit, image build, smoke, nop, and oracle. Blocks until the report is back (can take up to an hour). Budget-limited per session; the result says how many calls remain.",
    parameters: noArguments,
    async execute() {
      const loaded = loadTaskDeliverable(deliverable());
      if ("isError" in loaded) {
        return loaded;
      }
      const staging = stageSubmission(
        loaded.definition,
        loaded.testPatch,
        loaded.goldPatch,
        "selfbench-verify-",
      );
      try {
        const verdict = runStaticCheck(staging.directory);
        if (!verdict.ok) {
          return staticCheckFailure(verdict, "task");
        }
      } finally {
        staging.dispose();
      }
      const outcome = await client.verify("task", loaded);
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
      "Takes no arguments. Reads the deliverable in /work/task, runs the static check, and records the task; a passing submission ends the session. Run verify first and submit only what verify reported green.",
    parameters: noArguments,
    async execute() {
      const root = requiredEnvironment("SELFBENCH_TASK_OUTPUT");
      const loaded = loadTaskDeliverable(deliverable());
      if ("isError" in loaded) {
        return loaded;
      }
      const taskId = String(loaded.definition.taskId ?? "");
      const staging = stageSubmission(loaded.definition, loaded.testPatch, loaded.goldPatch);
      try {
        const verdict = runStaticCheck(staging.directory);
        if (!verdict.ok) {
          return staticCheckFailure(verdict, "submission");
        }
        const directory = join(root, taskId);
        mkdirSync(root, { recursive: true });
        mkdirSync(directory, { recursive: false });
        cpSync(staging.directory, directory, { recursive: true });
        const verified = client.verifiedGreen(loaded);
        return {
          content: [
            {
              type: "text",
              text: `Submitted ${taskId}; the static check passed and the Harbor tree is dry-rendered under ${verdict.renderedDirectory ?? "/work/rendered"}. ${verified ? "This deliverable matches your last green verify, so the worker reuses that report." : "This deliverable was not verified green in this session, so the worker verifies it now and a round is spent if it fails."} Stop here and wait.`,
            },
          ],
          details: { taskId, verified },
        };
      } finally {
        staging.dispose();
      }
    },
  });
}
