import type { ArtifactEntry, CandidateArtifacts } from "../types";

export interface AgentRound {
  id: string;
  title: string;
  stage: "authoring" | "verification";
  round: number;
  attempt: number;
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
  return [...rounds.values()].sort(
    (a, b) =>
      a.round - b.round ||
      Number(a.stage === "verification") - Number(b.stage === "verification") ||
      a.attempt - b.attempt,
  );
}
