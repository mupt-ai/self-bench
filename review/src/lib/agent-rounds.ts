import type { AgentRunRecord, ArtifactEntry, CandidateArtifacts } from "../types";

export interface AgentRound {
  id: string;
  title: string;
  stage: "authoring" | "review";
  round: number;
  attempt: number;
  startedAt: string;
  status?: "finished" | "failed";
  live?: ArtifactEntry;
  session?: ArtifactEntry;
}

/** One row per agent sandbox run, from the `agent.json` each run writes about itself. */
export function agentRounds(artifacts: CandidateArtifacts): AgentRound[] {
  const records = artifacts.agents;
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
      // A retried attempt failed even if its sandbox exited cleanly: the activity did not finish.
      const failed = Boolean(record.error) || (record.exitCode ?? 0) !== 0 || later(record);
      return {
        id: record.prefix,
        stage: record.stage,
        round: record.round,
        attempt: record.attempt,
        startedAt: record.startedAt,
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
