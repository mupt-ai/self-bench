import { Context } from "@temporalio/activity";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import {
  type Candidate,
  candidateSchema,
  type Difficulty,
  type DiscoveryResult,
  type RunRequest,
} from "../../contracts/index.js";
import type { SandboxExecutor } from "../../sandbox/index.js";
import { assertProvenanceMatchesPullRequest } from "../../third_party/github/provenance.js";
import { assertPullRequestBelongsToRepository } from "../../third_party/github/repository.js";
import { difficultyThresholds } from "../task/audit.js";
import { runAgent } from "./agent.js";
import { parseProvenance, readAsset } from "./helpers.js";
import { renderPrompt } from "./prompts.js";

export interface DiscoveryShardInput {
  /** The API already grouped this shard's PRs; otherwise the run's PRs are dealt round-robin. */
  readonly partitioned?: boolean;
  readonly run: RunRequest;
  readonly wave: number;
  readonly shardIndex: number;
  readonly shardCount: number;
  readonly targetCounts: Readonly<Record<Difficulty, number>>;
  readonly excludedSourcePrs: readonly number[];
}

const OUTPUT = "/work/discovery.json";
const planSchema = z.object({
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

/** One discovery agent picks candidate PRs from its shard; each becomes a Candidate with its request. */
export async function discoverCandidateShard(
  store: ArtifactStore,
  sandbox: SandboxExecutor,
  input: DiscoveryShardInput,
): Promise<DiscoveryResult> {
  const { run, wave, shardIndex } = input;
  const all = parseProvenance(await store.get(run.provenance));
  const shard = input.partitioned
    ? all
    : all.filter((_message, index) => index % input.shardCount === shardIndex);
  const prefix = `runs/${run.runId}/discovery/wave-${wave}/shard-${shardIndex}/attempt-${Context.current().info.attempt}`;
  const result = await runAgent({
    store,
    sandbox,
    run,
    label: `discover-${wave}-${shardIndex}`,
    prefix,
    logName: "modal.log",
    workspace: { kind: "clone", commit: run.repository.commit },
    extension: "/work/discovery.ts",
    tools: "read,bash,grep,find,ls,submit_discovery",
    prompt: renderPrompt("discovery", {
      repositoryUrl: run.repository.url,
      easy: input.targetCounts.easy,
      medium: input.targetCounts.medium,
      hard: input.targetCounts.hard,
      count: shard.length,
      tiers: Object.entries(difficultyThresholds)
        .map(
          ([tier, t]) => `${tier} ≥${t.changedLines} lines across ≥${t.implementationFiles} files`,
        )
        .join(", "),
    }),
    files: [
      {
        path: "/work/discovery.ts",
        contents: await readAsset("src/harnesses/pi/extensions/discovery.ts"),
      },
      { path: "/work/excluded-source-prs.json", contents: JSON.stringify(input.excludedSourcePrs) },
      {
        path: "/work/provenance.jsonl",
        contents: `${shard.map((message) => JSON.stringify(message)).join("\n")}\n`,
      },
    ],
    outputs: [OUTPUT],
    environment: {
      SELFBENCH_DISCOVERY_EXCLUSIONS: "/work/excluded-source-prs.json",
      SELFBENCH_DISCOVERY_OUTPUT: OUTPUT,
    },
    timeoutMs: 45 * 60 * 1000,
  });
  const planBytes = result.outputs[OUTPUT];
  if (result.exitCode !== 0 || !planBytes) {
    throw new Error(
      `discovery shard ${wave}/${shardIndex} returned no plan (exit ${result.exitCode}); log: ${result.log.uri}`,
    );
  }
  const plan = planSchema.parse(JSON.parse(Buffer.from(planBytes).toString("utf8")));
  const excluded = new Set(input.excludedSourcePrs);
  const seen = new Set<number>();
  const candidates: Candidate[] = [];
  for (const raw of plan.candidates) {
    assertPullRequestBelongsToRepository(run.repository.url, raw.sourceUrl, raw.sourcePr);
    // Over-quota, repeated, or excluded proposals are dropped rather than failing the shard.
    const perTier = candidates.filter(
      (candidate) => candidate.difficulty === raw.difficulty,
    ).length;
    if (
      seen.has(raw.sourcePr) ||
      excluded.has(raw.sourcePr) ||
      perTier >= input.targetCounts[raw.difficulty]
    )
      continue;
    const message = shard.find(
      (item) =>
        item.sourceType === raw.provenance.sourceType &&
        item.sessionId === raw.provenance.sessionId &&
        item.messageIndex === raw.provenance.messageIndex,
    );
    if (!message) throw new Error(`candidate ${raw.candidateId} references unknown provenance`);
    assertProvenanceMatchesPullRequest(message, raw.sourcePr, raw.sourceUrl);
    seen.add(raw.sourcePr);
    const candidateId = `w${wave}s${shardIndex}-${raw.candidateId}`;
    const provenance = await store.put(
      `runs/${run.runId}/provenance/${candidateId}.json`,
      Buffer.from(
        `${JSON.stringify({ source: message, messages: [{ role: "user", content: message.content }] })}\n`,
      ),
      "application/json",
    );
    candidates.push(
      candidateSchema.parse({ ...raw, candidateId, request: message.content, provenance }),
    );
  }
  const report = await store.put(
    `${prefix}/report.json`,
    Buffer.from(`${JSON.stringify({ candidates, logs: result.log }, null, 2)}\n`),
    "application/json",
  );
  return { candidates, report };
}
