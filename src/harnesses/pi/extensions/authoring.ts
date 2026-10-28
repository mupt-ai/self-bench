import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { SUBMISSION_FILES } from "../../../generation/task/submission.js";
import {
  requiredEnvironment,
  runStaticCheck,
  staticCheckFailure,
  type ToolFailure,
} from "./shared/static-check.js";

const noArguments = Type.Object({}, { additionalProperties: false });

/**
 * Static-checks the deliverable and packs its files as `<handOff>/source-task.tar.gz`.
 * Returns the tool failure when the static check fails.
 */
function packDeliverable(handOff: string): ToolFailure | undefined {
  const deliverable = process.env.SELFBENCH_DELIVERABLE ?? "/work/task";
  const verdict = runStaticCheck(deliverable);
  if (!verdict.ok) return staticCheckFailure(verdict);
  mkdirSync(handOff, { recursive: true });
  const archive = join(handOff, "source-task.tar.gz");
  const files = SUBMISSION_FILES.filter((name) => existsSync(join(deliverable, name)));
  const tar = spawnSync("tar", ["-czf", archive, "-C", deliverable, ...files]);
  if (tar.status !== 0) throw new Error(`could not pack the task: ${tar.stderr}`);
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
      "Takes no arguments. Static-checks the deliverable in /work/task (instruction.md, Dockerfile, smoke.sh, run-tests.sh, test.patch, gold.patch, and services.sh if the tests need services), then hands it to the worker, which compiles it and runs the real image build, smoke, nop, and oracle. This ends your turn: the report arrives as your next message, in a fresh sandbox with /work/task restored. Limited calls per round.",
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
      const failed = packDeliverable(requiredEnvironment("SELFBENCH_VERIFY_REQUEST"));
      if (failed) return failed;
      handedOff = true;
      return {
        content: [
          {
            type: "text",
            text: "Verification requested. Stop now: the report arrives as your next message.",
          },
        ],
        details: {},
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
      const failed = packDeliverable(requiredEnvironment("SELFBENCH_SUBMISSION"));
      if (failed) return failed;
      handedOff = true;
      return {
        content: [{ type: "text", text: "Submitted the task. Stop here." }],
        details: {},
        terminate: true,
      };
    },
  });
}
