import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { ArtifactStore } from "../../artifacts.js";
import type { ArtifactRef, RunRequest } from "../../contracts.js";
import { collectGitHubPullRequestProvenance, combineRunProvenance } from "../../provenance.js";
import { githubToken } from "../../subscription-auth.js";
import { parseProvenance, withActivityHeartbeats } from "./runtime.js";

export async function collectRunProvenance(
  store: ArtifactStore,
  run: RunRequest,
): Promise<ArtifactRef> {
  return await withActivityHeartbeats(
    "collecting merged GitHub pull requests",
    async ({ signal }) => {
      const [localBytes, token] = await Promise.all([store.get(run.provenance), githubToken()]);
      const local = parseProvenance(localBytes);
      const github = await collectGitHubPullRequestProvenance(run.repository.url, token, signal);
      const messages = combineRunProvenance(run.repository.url, local, github);
      if (messages.length === 0) {
        throw ApplicationFailure.nonRetryable(
          "no sanitized local-session or GitHub pull-request provenance was found",
          "NoProvenance",
        );
      }
      return await store.put(
        `runs/${run.runId}/input/combined-provenance-attempt-${Context.current().info.attempt}.jsonl`,
        Buffer.from(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`),
        "application/x-ndjson",
      );
    },
  );
}
