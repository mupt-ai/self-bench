import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { loadTaskDeliverable } from "./shared/deliverable.js";
import {
  requiredEnvironment,
  runStaticCheck,
  stageSubmission,
  staticCheckFailure,
} from "./shared/static-check.js";

const noArguments = Type.Object({}, { additionalProperties: false });

/**
 * Static-checks the deliverable and packs it as `<directory>/{definition.json,source-task.tar.gz}`.
 * Returns the tool failure when the static check fails.
 */
function packDeliverable(directory: string) {
  const loaded = loadTaskDeliverable(process.env.SELFBENCH_DELIVERABLE ?? "/work/task");
  if ("isError" in loaded) return loaded;
  const staging = stageSubmission(loaded.definition, loaded.testPatch, loaded.goldPatch);
  try {
    const base =
      typeof loaded.definition.baseCommit === "string" ? loaded.definition.baseCommit : "HEAD";
    const verdict = runStaticCheck(staging.directory, { base });
    if (!verdict.ok) return staticCheckFailure(verdict, "task");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "definition.json"), staging.definitionJson);
    const tar = spawnSync("tar", [
      "-czf",
      join(directory, "source-task.tar.gz"),
      "-C",
      staging.directory,
      ".",
    ]);
    if (tar.status !== 0) throw new Error(`could not pack the task: ${tar.stderr}`);
    return { taskId: String(loaded.definition.taskId ?? "") };
  } finally {
    staging.dispose();
  }
}

/**
 * `verify` and `submit_task` hand the deliverable to the worker and end the agent's turn. After a
 * verify the worker checks the task and resumes this session in a fresh sandbox with the report.
 */
export default function authoringExtension(pi: ExtensionAPI): void {
  const budget = Number(process.env.SELFBENCH_VERIFY_BUDGET ?? "0");
  // Both tools run sequentially, so every tool call after a hand-off reaches this check.
  let handedOff = false;
  pi.on("tool_call", () =>
    handedOff
      ? { block: true, reason: "The task was already handed to the worker. Stop now." }
      : undefined,
  );

  pi.registerTool({
    name: "verify",
    label: "Verify SelfBench task",
    description:
      "Takes no arguments. Static-checks the deliverable in /work/task (definition.json, instruction.md, test.patch, gold.patch), then hands it to the worker, which compiles it and runs the real image build, smoke, nop, and oracle. This ends your turn: the report arrives as your next message, in a fresh sandbox with /work/task restored. Limited calls per round.",
    parameters: noArguments,
    executionMode: "sequential",
    async execute() {
      if (budget <= 0) {
        return {
          content: [
            {
              type: "text",
              text: "No verify calls remain this round. Call submit_task with your best task, or explain why it can't be made fair.",
            },
          ],
          details: {},
          isError: true,
        };
      }
      const packed = packDeliverable(requiredEnvironment("SELFBENCH_VERIFY_REQUEST"));
      if ("isError" in packed) return packed;
      handedOff = true;
      return {
        content: [
          {
            type: "text",
            text: "Verification requested. Stop now: the report arrives as your next message.",
          },
        ],
        details: { taskId: packed.taskId },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "submit_task",
    label: "Submit SelfBench task",
    description:
      "Takes no arguments. Static-checks the deliverable in /work/task and records it as this round's submission. The worker verifies it again. Stop after submitting.",
    parameters: noArguments,
    executionMode: "sequential",
    async execute() {
      const packed = packDeliverable(requiredEnvironment("SELFBENCH_SUBMISSION"));
      if ("isError" in packed) return packed;
      handedOff = true;
      return {
        content: [{ type: "text", text: `Submitted ${packed.taskId}. Stop here.` }],
        details: { taskId: packed.taskId },
        terminate: true,
      };
    },
  });
}
