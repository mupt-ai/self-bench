import type { ArtifactEntry, CandidateArtifacts } from "../types";

export interface AgentRound {
  id: string;
  title: string;
  stage: "authoring" | "verification";
  round: number;
  attempt: number;
  /** The canonical round result belongs to the attempt that ultimately decided the round. */
  status?: "finished" | "failed";
  live?: ArtifactEntry;
  session?: ArtifactEntry;
  result?: ArtifactEntry;
}

export function agentRounds(artifacts: CandidateArtifacts): AgentRound[] {
  const rounds = new Map<string, AgentRound>();
  for (const stage of ["authoring", "verification"] as const) {
    const prefix = `runs/${artifacts.runId}/${stage}/${artifacts.candidateId}/`;
    for (const entry of artifacts.groups[stage] ?? []) {
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
        title: `${stage === "authoring" ? "Authoring" : "Verification"} Part ${round}`,
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
      Number(a.stage === "verification") - Number(b.stage === "verification") ||
      a.attempt - b.attempt,
  );
}
