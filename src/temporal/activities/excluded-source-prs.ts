import { ApplicationFailure } from "@temporalio/common";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts.js";
import { provenanceMessageSchema } from "../../provenance.js";
import { parseProvenance, safeHeartbeat } from "./runtime.js";

/** Shards probed per discovery wave; must cover every shard count a past run may have used. */
const MAX_PROBED_SHARDS = 16;
const MAX_DISCOVERY_ATTEMPTS = 5;
const MAX_PROBED_WAVES = 1_000;

const sourcePrSchema = z.number().int().positive();
const discoveryRecordSchema = z.object({
  candidates: z.array(z.object({ sourcePr: sourcePrSchema })),
});
const storedProvenanceSchema = z.object({ source: provenanceMessageSchema });
const storedDefinitionSchema = z.object({ sourcePr: sourcePrSchema });
const archivedStatusSchema = z.object({
  tasks: z.array(z.object({ candidateId: z.string().min(1) })),
});

/**
 * Collects every source pull request an earlier run processed, whatever its outcome there, so a
 * new run's discovery never proposes it again. Sources, in order: discovery plans and reports,
 * a replay run's rebuilt provenance, and the archived run status (`runs/<runId>/status.json`)
 * resolved through each candidate's stored provenance or authored definition.
 */
export async function collectExcludedSourcePrs(
  store: ArtifactStore,
  runIds: readonly string[],
): Promise<number[]> {
  const excluded = new Set<number>();
  for (const runId of new Set(runIds)) {
    safeHeartbeat(`collecting processed pull requests of ${runId}`);
    const found = await collectRunSourcePrs(store, runId);
    if (found === undefined) {
      throw ApplicationFailure.nonRetryable(
        `excluded run ${runId} has no discovery, replay, or status artifacts`,
        "ExcludedRunMissing",
      );
    }
    for (const sourcePr of found) {
      excluded.add(sourcePr);
    }
  }
  return [...excluded].sort((left, right) => left - right);
}

/** Undefined when the run left no candidate record at all (most likely a mistyped run ID). */
async function collectRunSourcePrs(
  store: ArtifactStore,
  runId: string,
): Promise<Set<number> | undefined> {
  const sourcePrs = new Set<number>();
  let recordsFound = false;
  const add = (values: Iterable<number>): void => {
    recordsFound = true;
    for (const value of values) {
      sourcePrs.add(value);
    }
  };
  for await (const discovered of discoveredSourcePrs(store, runId)) {
    add(discovered);
  }
  const replayed = await replayedSourcePrs(store, runId);
  if (replayed) {
    add(replayed);
  }
  const archived = await archivedCandidateIds(store, runId);
  if (archived) {
    add(await candidateSourcePrs(store, runId, archived));
  }
  return recordsFound ? sourcePrs : undefined;
}

async function* discoveredSourcePrs(store: ArtifactStore, runId: string): AsyncGenerator<number[]> {
  for (let wave = 0; wave < MAX_PROBED_WAVES; wave += 1) {
    let waveFound = false;
    for (let shard = 0; shard < MAX_PROBED_SHARDS; shard += 1) {
      const prefix = `runs/${runId}/discovery/wave-${wave}/shard-${shard}`;
      const keys = [
        `${prefix}/plan.json`,
        ...Array.from(
          { length: MAX_DISCOVERY_ATTEMPTS },
          (_unused, index) => `${prefix}/attempt-${index + 1}/report.json`,
        ),
      ];
      for (const key of keys) {
        const bytes = await store.getByKey(key);
        if (!bytes) {
          continue;
        }
        waveFound = true;
        yield discoveryRecordSchema
          .parse(parseJson(bytes))
          .candidates.map((candidate) => candidate.sourcePr);
      }
    }
    if (!waveFound) {
      return;
    }
    safeHeartbeat(`collected discovery wave ${wave} of ${runId}`);
  }
}

async function replayedSourcePrs(
  store: ArtifactStore,
  runId: string,
): Promise<number[] | undefined> {
  const bytes = await store.getByKey(`runs/${runId}/provenance/replay.jsonl`);
  if (!bytes) {
    return undefined;
  }
  return parseProvenance(bytes).flatMap((message) =>
    message.sourcePr === undefined ? [] : [message.sourcePr],
  );
}

async function archivedCandidateIds(
  store: ArtifactStore,
  runId: string,
): Promise<string[] | undefined> {
  const bytes = await store.getByKey(`runs/${runId}/status.json`);
  if (!bytes) {
    return undefined;
  }
  return archivedStatusSchema.parse(parseJson(bytes)).tasks.map((task) => task.candidateId);
}

async function candidateSourcePrs(
  store: ArtifactStore,
  runId: string,
  candidateIds: readonly string[],
): Promise<number[]> {
  const sourcePrs: number[] = [];
  for (const candidateId of candidateIds) {
    const sourcePr = await candidateSourcePr(store, runId, candidateId);
    if (sourcePr === undefined) {
      throw ApplicationFailure.nonRetryable(
        `excluded run ${runId} lists candidate ${candidateId} without a resolvable source pull request`,
        "ExcludedRunMissing",
      );
    }
    sourcePrs.push(sourcePr);
  }
  return sourcePrs;
}

async function candidateSourcePr(
  store: ArtifactStore,
  runId: string,
  candidateId: string,
): Promise<number | undefined> {
  const provenanceBytes = await store.getByKey(`runs/${runId}/provenance/${candidateId}.json`);
  if (provenanceBytes) {
    const { source } = storedProvenanceSchema.parse(parseJson(provenanceBytes));
    if (source.sourcePr !== undefined) {
      return source.sourcePr;
    }
  }
  const prefix = `runs/${runId}/authoring/${candidateId}`;
  for (const key of [`${prefix}/definition.json`, `${prefix}/round-1/definition.json`]) {
    const bytes = await store.getByKey(key);
    if (bytes) {
      return storedDefinitionSchema.parse(parseJson(bytes)).sourcePr;
    }
  }
  return undefined;
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString("utf8"));
}
