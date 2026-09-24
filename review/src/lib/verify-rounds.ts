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
  const nopDone = Boolean(file("smoke-nop.json"));
  const oracleDone = Boolean(file("oracle.json"));
  const done = Boolean(report);
  const state = (finished: boolean, started: boolean): VerifyStepState =>
    finished ? "done" : started && !done ? "running" : "pending";
  const startedAt = entries
    .map((entry) => entry.updatedAt ?? "")
    .filter(Boolean)
    .reduce((first, value) => (!first || value < first ? value : first), "");
  const live = oracleLive ?? nopLive;
  return {
    id: folder,
    title,
    startedAt,
    ...(report ? { report } : {}),
    ...(reportText ? { reportText } : {}),
    ...(live && !done ? { live } : {}),
    steps: [
      { label: "Compile", state: state(compiled || done, true) },
      {
        label: "Build, Smoke, and Tests Without Fix",
        state: state(nopDone || oracleDone || done, compiled),
      },
      { label: "Tests With Fix", state: state(oracleDone || (done && !!oracleLive), !!oracleLive) },
    ],
  };
}
