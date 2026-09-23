import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
const VERIFY_TIMEOUT_MS = 60 * 60 * 1000;

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

export default function authoringExtension(pi: ExtensionAPI): void {
  const budget = Number(process.env.SELFBENCH_VERIFY_BUDGET ?? "0");
  let used = 0;

  pi.registerTool({
    name: "verify",
    label: "Verify SelfBench task",
    description:
      "Takes no arguments. Checks the deliverable in /work/task (definition.json, instruction.md, test.patch, gold.patch): static checks here, then the worker compiles it and runs the real image build, smoke, nop, and oracle. Blocks until the report is back (up to an hour). Limited calls per round.",
    parameters: noArguments,
    async execute() {
      if (used >= budget) {
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
      const directory = join(requiredEnvironment("SELFBENCH_MAILBOX"), String(used + 1));
      const packed = packDeliverable(directory);
      if ("isError" in packed) return packed;
      used += 1;
      writeFileSync(join(directory, "ready"), "");
      const response = join(directory, "response.json");
      const deadline = Date.now() + VERIFY_TIMEOUT_MS;
      while (!existsSync(response)) {
        if (Date.now() > deadline) {
          return {
            content: [
              { type: "text", text: "verify timed out; submit your best task or try again." },
            ],
            details: {},
            isError: true,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const result = JSON.parse(readFileSync(response, "utf8")) as {
        green?: boolean;
        report?: string;
        error?: string;
      };
      const remaining = budget - used;
      const text = result.error
        ? `verify could not complete: ${result.error}. ${remaining} verify call(s) remain.`
        : `${result.report?.trim() ?? ""}\n\nverify result: green=${result.green === true}. ${remaining} verify call(s) remain. ${result.green ? "Call submit_task now." : "Fix what the report names and verify again."}`;
      return {
        content: [{ type: "text", text }],
        details: { green: result.green === true, remaining },
      };
    },
  });

  pi.registerTool({
    name: "submit_task",
    label: "Submit SelfBench task",
    description:
      "Takes no arguments. Static-checks the deliverable in /work/task and records it as this round's submission. The worker verifies it again. Stop after submitting.",
    parameters: noArguments,
    async execute() {
      const packed = packDeliverable(requiredEnvironment("SELFBENCH_SUBMISSION"));
      if ("isError" in packed) return packed;
      return {
        content: [{ type: "text", text: `Submitted ${packed.taskId}. Stop here.` }],
        details: { taskId: packed.taskId },
      };
    },
  });
}
