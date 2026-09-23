import type { AgentRunRecord, ArtifactEntry, CandidateArtifacts } from "../types";

export interface AgentRound {
  id: string;
  title: string;
  stage: "authoring" | "review";
  round: number;
  attempt: number;
  /** The canonical round result belongs to the attempt that ultimately decided the round. */
  status?: "finished" | "failed";
  live?: ArtifactEntry;
  session?: ArtifactEntry;
  result?: ArtifactEntry;
}

/** One row per agent sandbox run, from the `agent.json` each run writes about itself. */
export function agentRounds(artifacts: CandidateArtifacts): AgentRound[] {
  const records = artifacts.agents ?? [];
  if (records.length === 0) return legacyAgentRounds(artifacts);
  const entries = [...(artifacts.groups.authoring ?? []), ...(artifacts.groups.review ?? [])];
  const later = (record: AgentRunRecord) =>
    records.some(
      (other) =>
        other.stage === record.stage &&
        other.round === record.round &&
        other.turn === record.turn &&
        other.attempt > record.attempt,
    );
  return records
    .toSorted((a, b) => a.startedAt.localeCompare(b.startedAt))
    .map((record): AgentRound => {
      const live = entries
        .filter((entry) => entry.key.startsWith(`${record.prefix}/live/`))
        .reduce<ArtifactEntry | undefined>(
          (latest, entry) => (!latest || entry.key > latest.key ? entry : latest),
          undefined,
        );
      const session = entries.find((entry) => entry.key === record.session);
      const failed =
        Boolean(record.error) ||
        (record.exitCode ?? 0) !== 0 ||
        (!record.finishedAt && later(record));
      return {
        id: record.prefix,
        stage: record.stage,
        round: record.round,
        attempt: record.attempt,
        title: `${record.stage === "authoring" ? "Authoring" : "Review"} Part ${record.round}${record.turn ? `, Turn ${record.turn}` : ""}`,
        ...(failed
          ? { status: "failed" as const }
          : record.finishedAt
            ? { status: "finished" as const }
            : {}),
        ...(live ? { live } : {}),
        ...(session ? { session } : {}),
      };
    });
}

/** Runs from before agent.json: the rows are recovered from the artifact layout of that time. */
function legacyAgentRounds(artifacts: CandidateArtifacts): AgentRound[] {
  const rounds = new Map<string, AgentRound>();
  for (const sourceStage of ["authoring", "review", "verification"] as const) {
    const stage = sourceStage === "verification" ? "review" : sourceStage;
    const prefix = `runs/${artifacts.runId}/${sourceStage}/${artifacts.candidateId}/`;
    for (const entry of artifacts.groups[sourceStage] ?? []) {
      const path = entry.key.slice(prefix.length);
      const match =
        /^(?:round-(\d+)(?:\/attempt-(\d+))?\/|session\/round-(\d+)(?:-attempt-(\d+))?\.jsonl$)/.exec(
          path,
        );
      if (!entry.key.startsWith(prefix) || !match) continue;
      const round = Number(match[1] ?? match[3]);
      const attempt = Number(match[2] ?? match[4] ?? 1);
      const id = `${stage}-${round}-${attempt}`;
      const item = rounds.get(id) ?? {
        id,
        stage,
        round,
        attempt,
        title: `${stage === "authoring" ? "Authoring" : "Review"} Part ${round}`,
      };
      if (path.includes("/live/") && (!item.live || entry.key > item.live.key)) item.live = entry;
      if (path.startsWith("session/")) item.session = entry;
      if (path === `round-${round}/result.json`) item.result = entry;
      rounds.set(id, item);
    }
  }
  const grouped = new Map<string, AgentRound[]>();
  for (const round of rounds.values()) {
    const key = `${round.stage}-${round.round}`;
    const group = grouped.get(key) ?? [];
    group.push(round);
    grouped.set(key, group);
  }
  for (const group of grouped.values()) {
    const attempts = group.toSorted((a, b) => a.attempt - b.attempt);
    const resultAttempt = attempts.some((round) => round.result)
      ? (attempts.filter((round) => round.session).at(-1) ?? attempts.at(-1))
      : undefined;
    for (const round of attempts) {
      if (resultAttempt) {
        round.status = round === resultAttempt ? "finished" : "failed";
      } else if (round.attempt < (attempts.at(-1)?.attempt ?? round.attempt)) {
        round.status = "failed";
      }
    }
  }

  return [...rounds.values()].sort(
    (a, b) =>
      a.round - b.round ||
      Number(a.stage === "review") - Number(b.stage === "review") ||
      a.attempt - b.attempt,
  );
}
