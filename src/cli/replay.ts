import { parseArgs } from "node:util";
import { waitForRun } from "../run-wait.js";
import { download, requestJson } from "./api-client.js";
import { resolveSelfBenchCommit } from "./repository.js";
import { asPolledRunStatus, defaultRunId, fail } from "./values.js";

/** Re-runs known candidates of an earlier run through fresh authoring and verification. */
export async function replay(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      "source-run": { type: "string" },
      candidate: { type: "string", multiple: true },
      "run-id": { type: "string" },
      model: { type: "string", default: "gpt-5.6-sol" },
      wait: { type: "boolean", default: false },
      output: { type: "string", short: "o" },
    },
    strict: true,
  });
  const sourceRunId = parsed.values["source-run"] ?? fail("--source-run is required");
  const candidateIds = parsed.values.candidate ?? [];
  if (candidateIds.length === 0) {
    fail("at least one --candidate is required");
  }
  const runId = parsed.values["run-id"] ?? defaultRunId();
  const selfbenchCommit = await resolveSelfBenchCommit();
  const response = await requestJson("/v1/runs", {
    method: "POST",
    body: Buffer.from(
      JSON.stringify({
        runId,
        replay: { sourceRunId, candidateIds },
        authoringModel: parsed.values.model,
        selfbenchCommit,
      }),
    ),
    contentType: "application/json",
  });
  console.log(JSON.stringify({ ...response, sourceRunId, candidateIds }, null, 2));
  if (!parsed.values.wait && parsed.values.output === undefined) {
    return;
  }
  const status = await waitForRun({
    poll: async () =>
      asPolledRunStatus(
        await requestJson(`/v1/runs/${encodeURIComponent(runId)}`, { method: "GET" }),
      ),
    onPhase: (current) => {
      console.error(
        JSON.stringify({
          runId,
          phase: current.phase,
          accepted: current.accepted,
          rejected: current.rejected,
        }),
      );
    },
  });
  if (parsed.values.output !== undefined) {
    await download(runId, parsed.values.output);
  } else {
    console.log(JSON.stringify(status, null, 2));
  }
}
