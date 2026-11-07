import type { ArtifactEntry, CandidateArtifacts } from "../types";

/** One `verify` of a draft or submission: the compile job, then Harbor's two runs. */
export interface VerifyRound {
  id: string;
  title: string;
  /** When the check started: its first artifact. */
  startedAt: string;
  /** Written once, when the check finishes. */
  report?: ArtifactEntry;
  reportText?: ArtifactEntry;
  /** Latest Harbor progress snapshot, while Harbor runs. */
  live?: ArtifactEntry;
  steps: VerifyStep[];
}

export type VerifyStepState = "pending" | "running" | "done";

interface VerifyStep {
  label: string;
  state: VerifyStepState;
  /** When a step with no Harbor snapshot of its own started, for its running time. */
  since?: string;
}

/** One row per check, from the files under `verify/<candidate>/<stage>-round-<n>[-turn-<m>]/`. */
export function verifyRounds(artifacts: CandidateArtifacts): VerifyRound[] {
  const folders = new Map<string, ArtifactEntry[]>();
  for (const entry of artifacts.groups.verify ?? []) {
    const match = /\/verify\/[^/]+\/([^/]+)\//.exec(entry.key);
    if (!match?.[1]) continue;
    folders.set(match[1], [...(folders.get(match[1]) ?? []), entry]);
  }
  return [...folders.entries()]
    .map(([folder, entries]) => verifyRound(folder, entries))
    .filter((round): round is VerifyRound => round !== undefined)
    .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function verifyRound(folder: string, entries: ArtifactEntry[]): VerifyRound | undefined {
  const name = /^(\w+)-round-(\d+)(?:-turn-(\d+))?$/.exec(folder);
  if (!name) return undefined;
  const [, stage, round, turn] = name;
  const title =
    stage === "authoring"
      ? `Verify Part ${round}${turn ? `, Turn ${turn}` : " Submission"}`
      : `Verify ${stage === "review" ? "Review" : stage} ${round}`;
  const file = (suffix: string) =>
    entries.find((entry) => entry.key.endsWith(`/${folder}/${suffix}`));
  const latest = (pattern: RegExp) =>
    entries
      .filter((entry) => pattern.test(entry.key))
      .reduce<ArtifactEntry | undefined>(
        (last, entry) => (!last || entry.key > last.key ? entry : last),
        undefined,
      );
  const report = file("report.json");
  const reportText = file("report.md");
  // A retried verification publishes under a later attempt; only its snapshots are current.
  const attempt = latest(/\/live\/\d+-(nop|oracle)-\d+\.json$/)?.key.match(/\/live\/(\d+)-/)?.[1];
  const nopLive = attempt ? latest(new RegExp(`/live/${attempt}-nop-\\d+\\.json$`)) : undefined;
  const oracleLive = attempt
    ? latest(new RegExp(`/live/${attempt}-oracle-\\d+\\.json$`))
    : undefined;
  const compiled = entries.some((entry) => entry.key.endsWith("/harbor-task.tar.gz"));
  // Retries keep their gate outputs under attempt-<n>/, so an earlier attempt's never counts.
  const gateFile = (name: string) =>
    Number(attempt ?? 1) > 1 ? file(`attempt-${Number(attempt)}/${name}`) : file(name);
  const nopDone = Boolean(gateFile("smoke-nop.json"));
  const oracleDone = Boolean(gateFile("oracle.json"));
  const done = Boolean(report);
  const state = (finished: boolean, started: boolean): VerifyStepState =>
    finished ? "done" : started && !done ? "running" : "pending";
  const startedAt = entries
    .map((entry) => entry.updatedAt ?? "")
    .filter(Boolean)
    .reduce((first, value) => (!first || value < first ? value : first), "");
  const live = oracleLive ?? nopLive;
  // A deployment that builds task images marks each attempt's build start; that attempt's build is
  // done once its Harbor run starts, or the check ends (a failed build ends it).
  const buildAttemptOf = (entry: ArtifactEntry) =>
    Number(entry.key.match(/\/attempt-(\d+)\/images-started\.txt$/)?.[1] ?? 1);
  const building = entries
    .filter((entry) => entry.key.endsWith("/images-started.txt"))
    .reduce<ArtifactEntry | undefined>(
      (last, entry) => (!last || buildAttemptOf(entry) > buildAttemptOf(last) ? entry : last),
      undefined,
    );
  const buildAttempt = building ? buildAttemptOf(building) : 1;
  const testing = Number(attempt ?? 0) >= buildAttempt;
  const builtImages = done || (testing && Boolean(nopLive || nopDone || oracleDone));
  return {
    id: folder,
    title,
    startedAt,
    ...(report ? { report } : {}),
    ...(reportText ? { reportText } : {}),
    ...(live && !done ? { live } : {}),
    steps: [
      { label: "Compile", state: state(compiled || done, true) },
      ...(building
        ? [
            {
              label: "Build Images",
              state: state(builtImages, true),
              ...(building.updatedAt ? { since: building.updatedAt } : {}),
            },
            {
              label: "Smoke and Tests Without Fix",
              state: state(
                (testing && (nopDone || oracleDone)) || (done && !!nopLive),
                testing && !!nopLive,
              ),
            },
          ]
        : [
            {
              label: "Build, Smoke, and Tests Without Fix",
              state: state(nopDone || oracleDone || done, compiled),
            },
          ]),
      { label: "Tests With Fix", state: state(oracleDone || (done && !!oracleLive), !!oracleLive) },
    ],
  };
}
