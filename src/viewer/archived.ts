import type { ArtifactStore } from "../artifacts.js";
import type { Difficulty } from "../contracts.js";
import { parallelMap } from "../parallel.js";
import { latestBundleKey, latestDefinitionKey } from "./archived-keys.js";
import { reasonSummary, summarizeDefinition } from "./candidates.js";
import type { ArtifactEntry, CandidateList, CandidateStage, CandidateSummary } from "./types.js";

const DEFINITION_CONCURRENCY = 16;
const RUN_ID = /^runs\/([a-z0-9][a-z0-9-]{2,62})\//;
const LISTING_TTL_MS = 60_000;
const listingCache = new Map<string, { at: number; entries: Promise<ArtifactEntry[]> }>();
let runIndexCache: { at: number; runs: Promise<ArchivedRun[]> } | undefined;

/** Groups the pipeline keys by candidate ID; every other group is keyed by task ID. */
const CANDIDATE_KEYED_GROUPS = new Set(["authoring", "verification", "verify"]);

/** Listing a whole run is thousands of objects on GCS, so reuse it briefly across requests. */
function listRun(store: ArtifactStore, runId: string): Promise<ArtifactEntry[]> {
  const cached = listingCache.get(runId);
  if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.entries;
  const entries = store.list(`runs/${runId}`);
  listingCache.set(runId, { at: Date.now(), entries });
  entries.catch(() => listingCache.delete(runId));
  return entries;
}

export function clearArchivedListingCache(): void {
  listingCache.clear();
  runIndexCache = undefined;
}

export interface ArchivedRun {
  readonly runId: string;
  readonly status: "ARCHIVED";
  readonly startedAt?: string;
}

/**
 * Runs that exist in the artifact store, whether or not Temporal still remembers them.
 * The index walks every run in the store, so it is cached like the per-run listings.
 */
export function listArchivedRuns(store: ArtifactStore): Promise<ArchivedRun[]> {
  if (runIndexCache && Date.now() - runIndexCache.at < LISTING_TTL_MS) return runIndexCache.runs;
  const runs = scanArchivedRuns(store);
  const cached = { at: Date.now(), runs };
  runIndexCache = cached;
  runs.catch(() => {
    if (runIndexCache === cached) runIndexCache = undefined;
  });
  return runs;
}

async function scanArchivedRuns(store: ArtifactStore): Promise<ArchivedRun[]> {
  const entries = await store.list("runs").catch(() => [] as ArtifactEntry[]);
  const runs = new Map<string, string | undefined>();
  for (const entry of entries) {
    const runId = RUN_ID.exec(entry.key)?.[1];
    if (!runId) continue;
    const seen = runs.get(runId);
    if (!runs.has(runId) || (entry.updatedAt && (!seen || entry.updatedAt < seen))) {
      runs.set(runId, entry.updatedAt);
    }
  }
  return [...runs.entries()]
    .map(([runId, startedAt]) => ({
      runId,
      status: "ARCHIVED" as const,
      ...(startedAt ? { startedAt } : {}),
    }))
    .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""));
}

/**
 * Reconstruct a candidate table from the artifact tree alone. Stage is the furthest
 * pipeline group that wrote anything; status stays "archived" because the workflow's
 * final verdicts live only in Temporal.
 */
export async function archivedCandidates(
  store: ArtifactStore,
  runId: string,
): Promise<CandidateList> {
  const entries = await listRun(store, runId);
  const prefix = `runs/${runId}/`;
  const candidateIds = new Set<string>();
  for (const entry of entries) {
    const [group, second] = entry.key.slice(prefix.length).split("/");
    if (group && second && CANDIDATE_KEYED_GROUPS.has(group)) candidateIds.add(second);
  }
  const candidates = await parallelMap(
    [...candidateIds],
    DEFINITION_CONCURRENCY,
    async (candidateId) => {
      const definitionKey = latestDefinitionKey(entries, prefix, candidateId);
      const bytes = definitionKey
        ? await store.getByKey(definitionKey).catch(() => undefined)
        : undefined;
      const text = bytes ? Buffer.from(bytes).toString("utf8") : undefined;
      const definition = text ? summarizeDefinition(text) : undefined;
      const parsed = text ? parseIdentity(text) : undefined;
      const taskId = parsed?.taskId ?? candidateId;
      const groups = groupsFor(entries, prefix, { taskId, candidateId });
      const decision =
        (await latestRoundDecision(store, entries, prefix, candidateId)) ??
        (await latestReviewDecision(store, entries, prefix, taskId));
      const stage = decision?.stage ?? furthestStage(groups);
      const bundleKey = latestBundleKey(entries, prefix, candidateId);
      const candidate: CandidateSummary = {
        taskId,
        candidateId,
        difficulty: parsed?.difficulty ?? "easy",
        status: decision?.stage === "accepted" ? "accepted" : "archived",
        stage,
        reasonSummary:
          decision?.reasonSummary ?? `no verdict on record; last artifact written by ${stage}`,
        ...(decision?.reason ? { reason: decision.reason } : {}),
        ...(definition ? { definition } : {}),
        ...(definitionKey ? { definitionKey } : {}),
        ...(bundleKey ? { bundleKey } : {}),
      };
      return candidate;
    },
  );
  return {
    runId,
    phase: "archived",
    candidates: candidates.sort((left, right) => left.taskId.localeCompare(right.taskId)),
  };
}

interface ArchivedDecision {
  readonly stage: CandidateStage;
  readonly reasonSummary: string;
  readonly reason?: string;
}

const ROUND_RESULT = /^(authoring|verification)\/[^/]+\/round-(\d+)\/result\.json$/;

/**
 * The agent pipeline decides a candidate in its round results: the workflow accepts exactly when
 * a verification round's `result.json` is `accepted`, and a `rejected` round result in either loop
 * ends the candidate. The latest round of the later loop is the verdict on record.
 */
async function latestRoundDecision(
  store: ArtifactStore,
  entries: readonly ArtifactEntry[],
  prefix: string,
  candidateId: string,
): Promise<ArchivedDecision | undefined> {
  let latest: { key: string; loop: string; round: number } | undefined;
  for (const entry of entries) {
    const match = ROUND_RESULT.exec(entry.key.slice(prefix.length));
    if (!match || !match[1] || !match[2]) continue;
    if (entry.key.slice(prefix.length).split("/")[1] !== candidateId) continue;
    const loop = match[1];
    const round = Number(match[2]);
    const later =
      !latest ||
      (loop === "verification" && latest.loop === "authoring") ||
      (loop === latest.loop && round > latest.round);
    if (later) latest = { key: entry.key, loop, round };
  }
  if (!latest) return undefined;
  const value = await readJson(store, latest.key);
  if (!value) return undefined;
  const reason = typeof value.reason === "string" ? value.reason : undefined;
  const summary = reasonSummary(reason);
  if (latest.loop === "verification" && value.kind === "accepted") {
    return {
      stage: "accepted",
      reasonSummary: summary
        ? `verification agent accepted: ${summary}`
        : "verification agent accepted",
      ...(reason ? { reason } : {}),
    };
  }
  if (value.kind === "rejected") {
    return {
      stage: latest.loop === "verification" ? "review" : "authoring",
      reasonSummary: summary ?? `${latest.loop} round ${latest.round} rejected`,
      ...(reason ? { reason } : {}),
    };
  }
  return undefined;
}

/** Legacy runs accepted a task exactly when its last coupling review was clean. */
async function latestReviewDecision(
  store: ArtifactStore,
  entries: readonly ArtifactEntry[],
  prefix: string,
  taskId: string,
): Promise<ArchivedDecision | undefined> {
  const reviews = entries
    .filter(
      (entry) => entry.key.startsWith(`${prefix}reviews/${taskId}/`) && entry.key.endsWith(".json"),
    )
    .sort((left, right) =>
      (left.updatedAt ?? left.key).localeCompare(right.updatedAt ?? right.key),
    );
  const latest = reviews[reviews.length - 1];
  if (!latest) return undefined;
  const value = await readJson(store, latest.key);
  const verdict = typeof value?.verdict === "string" ? value.verdict : undefined;
  if (!verdict) return undefined;
  return verdict === "clean"
    ? { stage: "accepted", reasonSummary: "final coupling review was clean" }
    : { stage: "review", reasonSummary: `final coupling review: ${verdict}` };
}

async function readJson(
  store: ArtifactStore,
  key: string,
): Promise<Record<string, unknown> | undefined> {
  const bytes = await store.getByKey(key).catch(() => undefined);
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Every pipeline group that wrote under this candidate, whichever ID the group keys by. */
function groupsFor(
  entries: readonly ArtifactEntry[],
  prefix: string,
  ids: { taskId: string; candidateId: string },
): Set<string> {
  const groups = new Set<string>();
  for (const entry of entries) {
    const [group, second] = entry.key.slice(prefix.length).split("/");
    if (!group || !second) continue;
    const owner = CANDIDATE_KEYED_GROUPS.has(group) ? ids.candidateId : ids.taskId;
    if (second === owner) groups.add(group);
  }
  return groups;
}

function furthestStage(groups: Set<string>): CandidateStage {
  if (groups.has("repairs") || groups.has("reviews")) return "review";
  if (groups.has("validation-repairs") || groups.has("validation")) return "validation";
  if (groups.has("environment-preflights")) return "preflight";
  if (groups.has("audits")) return "audit";
  if (groups.has("environments")) return "environment";
  if (groups.has("authoring") || groups.has("verification") || groups.has("verify")) {
    return "authoring";
  }
  return "discovery";
}

function parseIdentity(text: string): { taskId?: string; difficulty?: Difficulty } | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const difficulty = value.difficulty;
    return {
      ...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
      ...(difficulty === "easy" || difficulty === "medium" || difficulty === "hard"
        ? { difficulty }
        : {}),
    };
  } catch {
    return undefined;
  }
}
