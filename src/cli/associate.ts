import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { collectRepositoryProvenanceWithMetadata } from "../provenance.js";
import {
  associationSessionSummaries,
  createProvenanceAssociationManifest,
  resolveMergedPullRequest,
  writeProvenanceAssociationManifest,
} from "../provenance-associations.js";
import { resolveRepository } from "./repository.js";
import { fail, positiveInteger } from "./values.js";

export async function associate(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      repo: { type: "string", short: "r" },
      pr: { type: "string" },
      session: { type: "string", multiple: true },
      output: { type: "string", short: "o" },
      "list-sessions": { type: "boolean", default: false },
    },
    strict: true,
  });
  const repositoryPath = resolve(parsed.values.repo ?? fail("--repo is required"));
  const [repository, collected] = await Promise.all([
    resolveRepository(repositoryPath),
    collectRepositoryProvenanceWithMetadata(repositoryPath, process.env.HOME ?? homedir()),
  ]);
  const localMessages = collected.messages;
  const sessions = associationSessionSummaries(localMessages, collected.sessions);
  if (parsed.values["list-sessions"]) {
    console.log(JSON.stringify({ repository: repository.url, sessions }, null, 2));
    return;
  }

  const sourcePr = positiveInteger(parsed.values.pr ?? fail("--pr is required"), "--pr");
  const output = resolve(parsed.values.output ?? fail("--output is required"));
  const selectors = parsed.values.session ?? [];
  const pullRequest = await resolveMergedPullRequest(repository.url, sourcePr);
  const manifest = createProvenanceAssociationManifest({
    repositoryUrl: repository.url,
    pullRequest,
    messages: localMessages,
    sessionSelectors: selectors,
  });
  await writeProvenanceAssociationManifest(output, manifest);
  console.log(
    JSON.stringify(
      {
        output,
        repository: manifest.repository,
        sourcePr: manifest.sourcePr,
        sourceUrl: manifest.sourceUrl,
        sessions: selectors.length,
        messages: manifest.messages.length,
      },
      null,
      2,
    ),
  );
}
