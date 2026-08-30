import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { MAX_CANDIDATES_PER_RUN } from "../contracts.js";
import { collectRepositoryProvenance } from "../provenance.js";
import { applyProvenanceAssociationManifests } from "../provenance-associations.js";
import { waitForRun } from "../run-wait.js";
import { download, requestJson } from "./api-client.js";
import { resolveRepository, resolveSelfBenchCommit } from "./repository.js";
import { asPolledRunStatus, defaultRunId, fail, nonnegativeInteger } from "./values.js";

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      repo: { type: "string", short: "r" },
      "easy-count": { type: "string" },
      "medium-count": { type: "string" },
      "hard-count": { type: "string" },
      "run-id": { type: "string" },
      model: { type: "string", default: "gpt-5.6-sol" },
      wait: { type: "boolean", default: false },
      output: { type: "string", short: "o" },
      association: { type: "string", multiple: true },
    },
    strict: true,
  });
  const repositoryPath = resolve(parsed.values.repo ?? fail("--repo is required"));
  const candidateCounts = {
    easy: nonnegativeInteger(parsed.values["easy-count"] ?? "0", "--easy-count"),
    medium: nonnegativeInteger(parsed.values["medium-count"] ?? "0", "--medium-count"),
    hard: nonnegativeInteger(parsed.values["hard-count"] ?? "0", "--hard-count"),
  };
  const totalCandidates = candidateCounts.easy + candidateCounts.medium + candidateCounts.hard;
  if (totalCandidates < 1 || totalCandidates > MAX_CANDIDATES_PER_RUN) {
    fail(`the total candidate count must be between 1 and ${MAX_CANDIDATES_PER_RUN}`);
  }
  const runId = parsed.values["run-id"] ?? defaultRunId();
  const [repository, collectedMessages, selfbenchCommit] = await Promise.all([
    resolveRepository(repositoryPath),
    collectRepositoryProvenance(repositoryPath, process.env.HOME ?? homedir()),
    resolveSelfBenchCommit(),
  ]);
  const localMessages = await applyProvenanceAssociationManifests(
    collectedMessages,
    repository.url,
    parsed.values.association ?? [],
  );
  const corpus = Buffer.from(
    localMessages.length > 0
      ? `${localMessages.map((message) => JSON.stringify(message)).join("\n")}\n`
      : "",
  );
  const provenance = await requestJson(`/v1/provenance?runId=${encodeURIComponent(runId)}`, {
    method: "POST",
    body: corpus,
    contentType: "application/x-ndjson",
  });
  const response = await requestJson("/v1/runs", {
    method: "POST",
    body: Buffer.from(
      JSON.stringify({
        runId,
        repository,
        provenance,
        candidateCounts,
        authoringModel: parsed.values.model,
        selfbenchCommit,
      }),
    ),
    contentType: "application/json",
  });
  console.log(
    JSON.stringify(
      {
        ...response,
        localProvenanceMessages: localMessages.length,
        associationManifests: parsed.values.association?.length ?? 0,
      },
      null,
      2,
    ),
  );
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
