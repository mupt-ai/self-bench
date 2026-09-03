import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts.js";
import {
  type Candidate,
  candidateSchema,
  commitSchema,
  type ReplayMaterial,
  type ReplayRunRequest,
} from "../../contracts.js";
import { githubRepository } from "../../github.js";
import { runCommand } from "../../process.js";
import { provenanceMessageSchema } from "../../provenance.js";
import { githubToken } from "../../subscription-auth.js";
import { safeHeartbeat } from "./runtime.js";

const MAX_DISCOVERY_ATTEMPTS = 5;

const storedProvenanceSchema = z.object({ source: provenanceMessageSchema });
const discoveryReportSchema = z.object({ candidates: z.array(candidateSchema) });
const storedDefinitionSchema = z.object({
  difficulty: z.enum(["easy", "medium", "hard"]),
  baseCommit: commitSchema,
  sourcePr: z.number().int().positive(),
  sourceUrl: z.string().url(),
});

export interface ReplayServices {
  /** Resolves the PR's completed commit the way discovery does (merge commit, else head). */
  resolveCompletedCommit(repository: string, pullRequest: number): Promise<string>;
  /** Current default-branch head, recorded as the run's repository commit. */
  resolveRepositoryHead(repository: string): Promise<string>;
}

/**
 * Rebuilds candidates from a source run's artifacts so previously failed candidates can be
 * replayed through fresh authoring and verification without discovery.
 */
export async function rebuildReplayCandidates(
  store: ArtifactStore,
  input: ReplayRunRequest,
  services: ReplayServices = defaultReplayServices,
): Promise<ReplayMaterial> {
  const candidates: Candidate[] = [];
  const messages: string[] = [];
  for (const candidateId of input.replay.candidateIds) {
    safeHeartbeat(`rebuilding ${candidateId} from ${input.replay.sourceRunId}`);
    const rebuilt = await rebuildReplayCandidate(
      store,
      input.replay.sourceRunId,
      candidateId,
      services,
    );
    candidates.push(rebuilt.candidate);
    messages.push(JSON.stringify(rebuilt.provenanceMessage));
  }
  const first = candidates[0];
  if (!first) {
    throw ApplicationFailure.nonRetryable("replay has no candidates", "InvalidReplay");
  }
  const repositoryUrl = repositoryUrlFromPullRequest(first.sourceUrl);
  const [provenance, commit] = await Promise.all([
    store.put(
      `runs/${input.runId}/provenance/replay.jsonl`,
      Buffer.from(`${messages.join("\n")}\n`),
      "application/x-ndjson",
    ),
    services.resolveRepositoryHead(githubRepository(repositoryUrl)),
  ]);
  return { candidates, repository: { url: repositoryUrl, commit }, provenance };
}

export async function rebuildReplayCandidate(
  store: ArtifactStore,
  sourceRunId: string,
  candidateId: string,
  services: ReplayServices,
): Promise<{ candidate: Candidate; provenanceMessage: z.infer<typeof provenanceMessageSchema> }> {
  const provenanceKey = `runs/${sourceRunId}/provenance/${candidateId}.json`;
  const provenanceBytes = await store.getByKey(provenanceKey);
  if (!provenanceBytes) {
    throw ApplicationFailure.nonRetryable(
      `replay candidate ${candidateId} has no provenance artifact at ${provenanceKey}`,
      "ReplayCandidateMissing",
    );
  }
  const provenanceMessage = storedProvenanceSchema.parse(
    JSON.parse(Buffer.from(provenanceBytes).toString("utf8")),
  ).source;
  const provenance = await store.put(provenanceKey, provenanceBytes, "application/json");
  const discovered = await findDiscoveredCandidate(store, sourceRunId, candidateId);
  if (discovered) {
    return {
      candidate: candidateSchema.parse({
        ...discovered,
        request: provenanceMessage.content,
        provenance,
      }),
      provenanceMessage,
    };
  }
  const definition = await findDefinition(store, sourceRunId, candidateId);
  if (!definition) {
    throw ApplicationFailure.nonRetryable(
      `replay candidate ${candidateId} has neither a discovery report nor an authored definition in ${sourceRunId}`,
      "ReplayCandidateMissing",
    );
  }
  const completedCommit = await services.resolveCompletedCommit(
    githubRepository(repositoryUrlFromPullRequest(definition.sourceUrl)),
    definition.sourcePr,
  );
  return {
    candidate: candidateSchema.parse({
      candidateId,
      difficulty: definition.difficulty,
      sourcePr: definition.sourcePr,
      sourceUrl: definition.sourceUrl,
      baseCommit: definition.baseCommit.toLowerCase(),
      completedCommit: completedCommit.toLowerCase(),
      request: provenanceMessage.content,
      provenance,
    }),
    provenanceMessage,
  };
}

async function findDiscoveredCandidate(
  store: ArtifactStore,
  sourceRunId: string,
  candidateId: string,
): Promise<Candidate | undefined> {
  const match = /^w(\d+)s(\d+)-/.exec(candidateId);
  if (!match) {
    return undefined;
  }
  for (let attempt = 1; attempt <= MAX_DISCOVERY_ATTEMPTS; attempt += 1) {
    const key = `runs/${sourceRunId}/discovery/wave-${match[1]}/shard-${match[2]}/attempt-${attempt}/report.json`;
    const bytes = await store.getByKey(key);
    if (!bytes) {
      continue;
    }
    const report = discoveryReportSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    const found = report.candidates.find((candidate) => candidate.candidateId === candidateId);
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function findDefinition(
  store: ArtifactStore,
  sourceRunId: string,
  candidateId: string,
): Promise<z.infer<typeof storedDefinitionSchema> | undefined> {
  const prefix = `runs/${sourceRunId}/authoring/${candidateId}`;
  for (const key of [`${prefix}/definition.json`, `${prefix}/round-1/definition.json`]) {
    const bytes = await store.getByKey(key);
    if (bytes) {
      return storedDefinitionSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    }
  }
  return undefined;
}

function repositoryUrlFromPullRequest(sourceUrl: string): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/i.exec(sourceUrl);
  if (!match?.[1] || !match[2]) {
    throw ApplicationFailure.nonRetryable(`invalid pull request URL ${sourceUrl}`, "InvalidReplay");
  }
  return `https://github.com/${match[1]}/${match[2]}.git`;
}

const defaultReplayServices: ReplayServices = {
  async resolveCompletedCommit(repository, pullRequest): Promise<string> {
    const result = await runCommand(
      "gh",
      ["pr", "view", String(pullRequest), "--repo", repository, "--json", "mergeCommit,headRefOid"],
      { env: await githubEnvironment() },
    );
    const parsed = JSON.parse(result.stdout) as {
      mergeCommit?: { oid?: string } | null;
      headRefOid?: string;
    };
    const commit = parsed.mergeCommit?.oid ?? parsed.headRefOid;
    if (!commit) {
      throw new Error(`pull request ${repository}#${pullRequest} has no merge or head commit`);
    }
    return commit;
  },
  async resolveRepositoryHead(repository): Promise<string> {
    const result = await runCommand(
      "gh",
      ["api", `repos/${repository}/commits/HEAD`, "--jq", ".sha"],
      { env: await githubEnvironment() },
    );
    return commitSchema.parse(result.stdout.trim());
  },
};

async function githubEnvironment(): Promise<NodeJS.ProcessEnv> {
  const token = await githubToken();
  return token ? { ...process.env, GH_TOKEN: token } : process.env;
}
