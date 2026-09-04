import type { ArtifactStore } from "../artifacts.js";
import type { TaskProgress } from "../contracts.js";
import {
  ARTIFACT_GROUPS,
  type ArtifactEntry,
  type ArtifactGroup,
  type BundleRef,
  type BundleStage,
  type CandidateArtifacts,
} from "./types.js";

const BUNDLE_NAMES = ["harbor-task.tar.gz", "source-task.tar.gz"];

export async function candidateArtifacts(
  store: ArtifactStore,
  runId: string,
  task: Pick<TaskProgress, "taskId" | "candidateId">,
): Promise<CandidateArtifacts> {
  const listed = await Promise.all(
    ARTIFACT_GROUPS.map(async (group) => {
      const prefix = groupPrefix(runId, group, task);
      const listed = await store.list(prefix).catch(() => [] as ArtifactEntry[]);
      const entries =
        group === "provenance"
          ? listed.filter((entry) => entry.key.endsWith(`/${task.candidateId}.json`))
          : listed;
      return [group, entries] as const;
    }),
  );
  const groups = Object.fromEntries(listed) as unknown as Record<
    ArtifactGroup,
    readonly ArtifactEntry[]
  >;
  const bundles: BundleRef[] = [];
  for (const [group, entries] of listed) {
    const stage = bundleStage(group);
    if (!stage) continue;
    for (const entry of entries) {
      if (BUNDLE_NAMES.some((name) => entry.key.endsWith(`/${name}`))) {
        bundles.push({ ...entry, stage });
      }
    }
  }
  bundles.sort(compareBundles);
  return { runId, taskId: task.taskId, candidateId: task.candidateId, groups, bundles };
}

export function groupPrefix(
  runId: string,
  group: ArtifactGroup,
  task: Pick<TaskProgress, "taskId" | "candidateId">,
): string {
  switch (group) {
    case "authoring":
      return `runs/${runId}/authoring/${task.candidateId}`;
    case "verification":
      return `runs/${runId}/verification/${task.candidateId}`;
    case "verify":
      return `runs/${runId}/verify/${task.candidateId}`;
    case "provenance":
      return `runs/${runId}/provenance`;
    default:
      return `runs/${runId}/${group}/${task.taskId}`;
  }
}

function bundleStage(group: ArtifactGroup): BundleStage | undefined {
  switch (group) {
    case "verification":
      return "verification";
    case "verify":
      return "verify";
    case "authoring":
      return "authoring";
    case "environments":
      return "environment";
    case "validation-repairs":
      return "validation-repair";
    case "repairs":
      return "repair";
    default:
      return undefined;
  }
}

const STAGE_ORDER: Record<BundleStage, number> = {
  verification: 0,
  verify: 1,
  repair: 2,
  "validation-repair": 3,
  environment: 4,
  authoring: 5,
};

/** Compiled Harbor trees first (they hold the environment, tests, and solution), newest first. */
function compareBundles(left: BundleRef, right: BundleRef): number {
  const compiled =
    Number(right.key.endsWith("/harbor-task.tar.gz")) -
    Number(left.key.endsWith("/harbor-task.tar.gz"));
  if (compiled !== 0) {
    return compiled;
  }
  if (left.updatedAt && right.updatedAt && left.updatedAt !== right.updatedAt) {
    return left.updatedAt < right.updatedAt ? 1 : -1;
  }
  return STAGE_ORDER[left.stage] - STAGE_ORDER[right.stage] || left.key.localeCompare(right.key);
}

export function isRunArtifactKey(runId: string, key: string): boolean {
  return (
    key.startsWith(`runs/${runId}/`) &&
    !key.includes("\\") &&
    !key.includes("\0") &&
    !key.split("/").some((part) => !part || part === "." || part === "..")
  );
}

export function artifactContentType(key: string): string {
  if (key.endsWith(".json")) return "application/json; charset=utf-8";
  if (key.endsWith(".jsonl")) return "application/x-ndjson; charset=utf-8";
  if (key.endsWith(".tar.gz") || key.endsWith(".tgz")) return "application/gzip";
  if (/\.(log|txt|md|patch|sh|toml|yaml|yml)$/.test(key)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
