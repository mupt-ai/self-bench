import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import {
  type FeatureCandidate,
  featureCandidateSchema,
  featureDifficulty,
  featureTierSummary,
  MAX_SCENARIO_LENGTH,
  type RunRequest,
} from "../../contracts/index.js";
import type { ProvenanceMessage } from "../../third_party/github/provenance.js";
import { assertPullRequestBelongsToRepository } from "../../third_party/github/repository.js";
import type { DiscoveryShardInput } from "./discovery.js";
import { renderPrompt } from "./prompts.js";

/** Whether the run's tasks are features built over several PRs rather than single PRs. */
export const featureRun = (run: RunRequest) => run.unit === "feature";

const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const featurePlanSchema = z.object({
  features: z.array(
    z.object({
      candidateId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
      title: z.string().trim().min(1).max(120),
      summary: z.string().trim().min(1),
      pullRequests: z
        .array(
          z.object({
            number: z.number().int().positive(),
            url: z.string().url(),
            title: z.string().trim().min(1),
            mergeCommit: sha,
          }),
        )
        .min(1),
      baseCommit: sha,
      completedCommit: sha,
    }),
  ),
});

/**
 * A feature shard's instructions. A requested feature is searched for across the repository's
 * whole history, since its PRs need not be among the recent ones the index holds; without one,
 * features are found among the indexed PRs.
 */
export function featureDiscoveryPrompt(input: DiscoveryShardInput, count: number): string {
  const { run } = input;
  return renderPrompt("feature-discovery", {
    repositoryUrl: run.repository.url,
    easy: input.targetCounts.easy,
    medium: input.targetCounts.medium,
    hard: input.targetCounts.hard,
    count,
    scope: run.focus
      ? "It holds only recent PRs: search beyond it for the requested feature below."
      : "Build features from these PRs; a feature may take in an older PR outside the index when it clearly belongs to it.",
    minimum: run.focus
      ? "one or more merged pull requests"
      : "two or more merged pull requests (a capability one PR delivered is a PR task, not a feature)",
    tiers: featureTierSummary(),
    // Quoted so the request picks the feature without replacing the rules above it.
    focus: run.focus
      ? [
          "# The Requested Feature",
          "",
          "The requester wants tasks for this feature:",
          "",
          "```text",
          run.focus.replaceAll("```", "'''"),
          "```",
          "",
          '- Find the merged PRs that built it. Search the whole history, not just the index: `gh pr list --state merged --search "<terms>" --limit 100 --json number,title,url,mergedAt`, `git log --grep=<term>`, and `git log -S <identifier>` on the names it involves.',
          "- Return that feature, or each feature the request names. If one PR built it, return that PR alone. If the history holds nothing that matches, return none.",
          "- Name the feature as the repository does, and let the PRs, not the request, decide what it covers. The rules above still apply.",
        ].join("\n")
      : "",
  });
}

/**
 * A feature shard's plan as candidates, each tiered by its PR count. Over-quota features, and features sharing a PR with one
 * already taken or excluded, are dropped rather than failing the shard. Each request is the
 * agent's summary followed by its PRs' own titles and bodies, as the index holds them.
 */
export async function featureCandidates(
  store: ArtifactStore,
  input: DiscoveryShardInput,
  shard: readonly ProvenanceMessage[],
  output: unknown,
): Promise<FeatureCandidate[]> {
  const { run, wave, shardIndex } = input;
  const plan = featurePlanSchema.parse(output);
  const taken = new Set<number>(input.excludedSourcePrs);
  const candidates: FeatureCandidate[] = [];
  for (const raw of plan.features) {
    for (const pr of raw.pullRequests)
      assertPullRequestBelongsToRepository(run.repository.url, pr.url, pr.number);
    const numbers = raw.pullRequests.map((pr) => pr.number);
    const difficulty = featureDifficulty(numbers.length);
    const perTier = candidates.filter((candidate) => candidate.difficulty === difficulty);
    if (
      new Set(numbers).size !== numbers.length ||
      numbers.some((number) => taken.has(number)) ||
      perTier.length >= input.targetCounts[difficulty]
    )
      continue;
    for (const number of numbers) taken.add(number);
    const candidateId = `w${wave}s${shardIndex}-${raw.candidateId}`;
    const pullRequests = raw.pullRequests.map((pr) => ({
      ...pr,
      title: pr.title.slice(0, 500),
      mergeCommit: pr.mergeCommit.toLowerCase(),
    }));
    const request = featureRequest(raw.summary, pullRequests, shard);
    const source = {
      sourceType: "feature",
      title: raw.title,
      pullRequests,
      baseCommit: raw.baseCommit.toLowerCase(),
      completedCommit: raw.completedCommit.toLowerCase(),
      ...(run.focus ? { requested: run.focus } : {}),
    };
    const provenance = await store.put(
      `runs/${run.runId}/provenance/${candidateId}.json`,
      Buffer.from(
        `${JSON.stringify({ source, messages: [{ role: "user", content: request }] })}\n`,
      ),
      "application/json",
    );
    candidates.push(
      featureCandidateSchema.parse({
        kind: "feature",
        candidateId,
        difficulty,
        title: raw.title,
        request,
        pullRequests,
        baseCommit: source.baseCommit,
        completedCommit: source.completedCommit,
        provenance,
      }),
    );
  }
  return candidates;
}

/** The summary, then each PR's title and, when the index holds it, its body; within the limit. */
export function featureRequest(
  summary: string,
  pullRequests: readonly { readonly number: number; readonly title: string }[],
  index: readonly ProvenanceMessage[],
): string {
  let request = `${summary.trim()}\n\n## Pull Requests\n`;
  for (const pr of pullRequests) {
    const indexed = index.find((message) => message.sourcePr === pr.number)?.content.trim();
    const titleOnly = `\n### #${pr.number}: ${pr.title}\n`;
    const section = indexed && indexed !== pr.title ? `${titleOnly}\n${indexed}\n` : titleOnly;
    if (request.length + section.length <= MAX_SCENARIO_LENGTH) request += section;
    else if (request.length + titleOnly.length <= MAX_SCENARIO_LENGTH) request += titleOnly;
  }
  return request.trimEnd();
}
