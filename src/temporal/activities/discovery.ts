import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts.js";
import {
  type ArtifactRef,
  type Candidate,
  candidateSchema,
  type Difficulty,
  type DiscoveryResult,
  type RunRequest,
} from "../../contracts.js";
import { assertPullRequestBelongsToRepository } from "../../github.js";
import { assertProvenanceMatchesPullRequest, type ProvenanceMessage } from "../../provenance.js";
import type { SandboxExecutor } from "../../sandbox/index.js";
import { githubToken, loadPiModelAuth } from "../../subscription-auth.js";
import { discoveryShardPrompt, modalAgentScript } from "./agent-scripts.js";
import { AGENT_INACTIVITY_TIMEOUT_MS, DISCOVERY_TIMEOUT_MS } from "./constants.js";
import {
  parseProvenance,
  readAsset,
  runSandboxWithFailureLog,
  withActivityHeartbeats,
} from "./runtime.js";
import type { DiscoveryShardInput } from "./types.js";

const discoveryPlanSchema = z.object({
  candidates: z.array(
    z.object({
      candidateId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      difficulty: z.enum(["easy", "medium", "hard"]),
      sourcePr: z.number().int().positive(),
      sourceUrl: z.string().url(),
      baseCommit: z.string().regex(/^[0-9a-f]{40}$/i),
      completedCommit: z.string().regex(/^[0-9a-f]{40}$/i),
      provenance: z.object({
        sourceType: z.enum(["pi", "claude-code", "codex", "generic", "github-pull-request"]),
        sessionId: z.string().min(1),
        messageIndex: z.number().int().nonnegative(),
      }),
    }),
  ),
});

export async function discoverCandidateShard(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: DiscoveryShardInput,
): Promise<DiscoveryResult> {
  const { run } = input;
  if (
    !Number.isInteger(input.wave) ||
    input.wave < 0 ||
    !Number.isInteger(input.shardIndex) ||
    !Number.isInteger(input.shardCount) ||
    Object.values(input.targetCounts).some((count) => !Number.isInteger(count) || count < 0) ||
    Object.values(input.targetCounts).every((count) => count === 0) ||
    input.shardIndex < 0 ||
    input.shardIndex >= input.shardCount
  ) {
    throw ApplicationFailure.nonRetryable(
      `invalid discovery shard ${input.shardIndex}/${input.shardCount}`,
      "InvalidDiscoveryShard",
    );
  }
  Context.current().heartbeat(
    `loading provenance for discovery wave ${input.wave} shard ${input.shardIndex}`,
  );
  const provenanceBytes = await store.get(run.provenance);
  const provenance = parseProvenance(provenanceBytes);
  const shard = provenance.filter(
    (_message, index) => index % input.shardCount === input.shardIndex,
  );
  const shardBytes = Buffer.from(`${shard.map((message) => JSON.stringify(message)).join("\n")}\n`);
  const shardPrefix = `runs/${run.runId}/discovery/wave-${input.wave}/shard-${input.shardIndex}`;
  const attemptPrefix = `${shardPrefix}/attempt-${Context.current().info.attempt}`;
  const checkpointKey = `${shardPrefix}/plan.json`;
  let planBytes = await store.getByKey(checkpointKey);
  let logs: ArtifactRef;
  if (planBytes) {
    logs = await store.put(
      `${attemptPrefix}/checkpoint.log`,
      Buffer.from("reused validated discovery shard checkpoint\n"),
      "text/plain",
    );
  } else {
    const [extension, piAuth, ghToken] = await Promise.all([
      readAsset("src/extensions/discovery.ts"),
      loadPiModelAuth(),
      githubToken(),
    ]);
    Context.current().heartbeat(
      `starting discovery wave ${input.wave} shard ${input.shardIndex} over ${shard.length} messages`,
    );
    const result = await runSandboxWithFailureLog(store, `${attemptPrefix}/modal.log`, () =>
      withActivityHeartbeats(
        `running discovery wave ${input.wave} shard ${input.shardIndex}`,
        (options) =>
          sandbox.run(
            {
              runId: run.runId,
              stage: `discover-${input.wave}-${input.shardIndex}`,
              timeoutMs: DISCOVERY_TIMEOUT_MS,
              inactivityTimeoutMs: AGENT_INACTIVITY_TIMEOUT_MS,
              files: [
                { path: "/work/discovery.ts", contents: extension },
                {
                  path: "/work/excluded-source-prs.json",
                  contents: JSON.stringify(input.excludedSourcePrs),
                },
                { path: "/work/provenance.jsonl", contents: shardBytes },
                { path: "/work/prompt.txt", contents: discoveryShardPrompt(input, shard.length) },
              ],
              outputPaths: ["/work/discovery.json"],
              secrets: {
                ...(piAuth.apiKey ? { OPENAI_API_KEY: piAuth.apiKey } : {}),
                ...(piAuth.authJson ? { SELFBENCH_PI_AUTH_JSON: piAuth.authJson } : {}),
                ...(ghToken ? { GH_TOKEN: ghToken } : {}),
              },
              environment: {
                SOURCE_REPO_URL: run.repository.url,
                SOURCE_COMMIT: run.repository.commit,
                AUTHOR_MODEL: run.authoring.model,
                SELFBENCH_DISCOVERY_EXCLUSIONS: "/work/excluded-source-prs.json",
                SELFBENCH_DISCOVERY_OUTPUT: "/work/discovery.json",
              },
              command: ["bash", "-lc", modalAgentScript("discovery.ts", "submit_discovery")],
            },
            options,
          ),
      ),
    );
    planBytes = result.outputs["/work/discovery.json"];
    logs = await store.put(
      `${attemptPrefix}/modal.log`,
      Buffer.from(`${result.stdout}\n${result.stderr}`),
      "text/plain",
    );
    if (result.exitCode !== 0 || !planBytes) {
      throw new Error(`discovery shard failed in ${result.sandboxId}; log: ${logs.uri}`);
    }
    parseDiscoveryPlan(planBytes, input.targetCounts, input.excludedSourcePrs, run.repository.url);
    await store.put(checkpointKey, planBytes, "application/json");
  }
  return await materializeDiscovery(
    store,
    run,
    shard,
    provenance,
    planBytes,
    logs,
    input.targetCounts,
    input.excludedSourcePrs,
    `${attemptPrefix}/report.json`,
    `w${input.wave}s${input.shardIndex}`,
  );
}

async function materializeDiscovery(
  store: ArtifactStore,
  run: RunRequest,
  provenance: readonly ProvenanceMessage[],
  allProvenance: readonly ProvenanceMessage[],
  planBytes: Uint8Array,
  logs: ArtifactRef,
  maxCandidates: Readonly<Record<Difficulty, number>>,
  excludedSourcePrs: readonly number[],
  reportKey: string,
  candidatePrefix: string,
): Promise<DiscoveryResult> {
  const plan = parseDiscoveryPlan(planBytes, maxCandidates, excludedSourcePrs, run.repository.url);

  const candidates: Candidate[] = [];
  for (const raw of plan.candidates) {
    const message = selectCandidateProvenance(provenance, allProvenance, raw);
    const staged = Buffer.from(
      `${JSON.stringify({ source: message, messages: [{ role: "user", content: message.content }] })}\n`,
    );
    const candidateId = `${candidatePrefix}-${raw.candidateId}`;
    const provenanceRef = await store.put(
      `runs/${run.runId}/provenance/${candidateId}.json`,
      staged,
      "application/json",
    );
    candidates.push(
      candidateSchema.parse({
        ...raw,
        candidateId,
        request: message.content,
        provenance: provenanceRef,
      }),
    );
  }
  const report = await store.put(
    reportKey,
    Buffer.from(`${JSON.stringify({ candidates, logs }, null, 2)}\n`),
    "application/json",
  );
  return { candidates, report };
}

export function selectCandidateProvenance(
  available: readonly ProvenanceMessage[],
  allProvenance: readonly ProvenanceMessage[],
  candidate: {
    readonly candidateId: string;
    readonly sourcePr: number;
    readonly sourceUrl: string;
    readonly provenance: {
      readonly sourceType: ProvenanceMessage["sourceType"];
      readonly sessionId: string;
      readonly messageIndex: number;
    };
  },
): ProvenanceMessage {
  const message = available.find(
    (item) =>
      item.sourceType === candidate.provenance.sourceType &&
      item.sessionId === candidate.provenance.sessionId &&
      item.messageIndex === candidate.provenance.messageIndex,
  );
  if (!message) {
    throw new Error(`candidate ${candidate.candidateId} references unknown provenance`);
  }
  assertProvenanceMatchesPullRequest(
    message,
    candidate.sourcePr,
    candidate.sourceUrl,
    allProvenance,
  );
  return message;
}

function parseDiscoveryPlan(
  planBytes: Uint8Array,
  maxCandidates: Readonly<Record<Difficulty, number>>,
  excludedSourcePrs: readonly number[],
  repositoryUrl: string,
) {
  const plan = discoveryPlanSchema.parse(JSON.parse(Buffer.from(planBytes).toString("utf8")));
  for (const difficulty of ["easy", "medium", "hard"] as const) {
    const actual = plan.candidates.filter(
      (candidate) => candidate.difficulty === difficulty,
    ).length;
    if (actual > maxCandidates[difficulty]) {
      throw new Error(
        `discovery produced ${actual} ${difficulty} candidates; expected at most ${maxCandidates[difficulty]}`,
      );
    }
  }
  const candidateIds = new Set<string>();
  const sourcePrs = new Set<number>();
  const excluded = new Set(excludedSourcePrs);
  for (const candidate of plan.candidates) {
    assertPullRequestBelongsToRepository(repositoryUrl, candidate.sourceUrl, candidate.sourcePr);
    if (candidateIds.has(candidate.candidateId)) {
      throw new Error(`discovery repeated candidate ID ${candidate.candidateId}`);
    }
    if (sourcePrs.has(candidate.sourcePr)) {
      throw new Error(`discovery repeated pull request ${candidate.sourcePr}`);
    }
    if (excluded.has(candidate.sourcePr)) {
      throw new Error(`discovery returned excluded pull request ${candidate.sourcePr}`);
    }
    candidateIds.add(candidate.candidateId);
    sourcePrs.add(candidate.sourcePr);
  }
  return plan;
}
