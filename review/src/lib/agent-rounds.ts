import type { ArtifactEntry, CandidateArtifacts } from "../types";

export interface AgentRound {
  id: string;
  title: string;
  stage: "authoring" | "review";
  round: number;
  /** Authoring turns within a round (each `verify` ends one); absent for older runs and reviews. */
  turn?: number;
  attempt: number;
  /** The canonical round result belongs to the attempt that ultimately decided the round. */
  status?: "finished" | "failed";
  live?: ArtifactEntry;
  session?: ArtifactEntry;
  result?: ArtifactEntry;
}

export function agentRounds(artifacts: CandidateArtifacts): AgentRound[] {
  const rounds = new Map<string, AgentRound>();
  // Rows seen only through a round-level result.json; turn-based rounds write one beside their turns.
  const resultOnly = new Set<string>();
  for (const sourceStage of ["authoring", "review", "verification"] as const) {
    const stage = sourceStage === "verification" ? "review" : sourceStage;
    const prefix = `runs/${artifacts.runId}/${sourceStage}/${artifacts.candidateId}/`;
    for (const entry of artifacts.groups[sourceStage] ?? []) {
      const path = entry.key.slice(prefix.length);
      const match =
        /^(?:round-(\d+)(?:\/turn-(\d+))?(?:\/attempt-(\d+))?\/|session\/round-(\d+)(?:-turn-(\d+))?(?:-attempt-(\d+))?\.jsonl$)/.exec(
          path,
        );
      if (!entry.key.startsWith(prefix) || !match) continue;
      const round = Number(match[1] ?? match[4]);
      const turnMatch = match[2] ?? match[5];
      const turn = turnMatch ? Number(turnMatch) : undefined;
      const attempt = Number(match[3] ?? match[6] ?? 1);
      const id = `${stage}-${round}-${turn ?? 0}-${attempt}`;
      const item = rounds.get(id) ?? {
        id,
        stage,
        round,
        ...(turn ? { turn } : {}),
        attempt,
        title: `${stage === "authoring" ? "Authoring" : "Review"} Part ${round}${turn ? `, Turn ${turn}` : ""}`,
      };
      if (path.includes("/live/") && (!item.live || entry.key > item.live.key)) item.live = entry;
      if (path.startsWith("session/")) item.session = entry;
      const isResult = path === `round-${round}${turn ? `/turn-${turn}` : ""}/result.json`;
      if (isResult) item.result = entry;
      if (isResult && !rounds.has(id)) resultOnly.add(id);
      else if (!isResult) resultOnly.delete(id);
      rounds.set(id, item);
    }
  }
  for (const id of resultOnly) {
    const item = rounds.get(id);
    const hasTurns = [...rounds.values()].some(
      (other) => other.stage === item?.stage && other.round === item?.round && other.turn,
    );
    if (hasTurns) rounds.delete(id);
  }
  const grouped = new Map<string, AgentRound[]>();
  for (const round of rounds.values()) {
    const key = `${round.stage}-${round.round}-${round.turn ?? 0}`;
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
      (a.turn ?? 0) - (b.turn ?? 0) ||
      a.attempt - b.attempt,
  );
}
