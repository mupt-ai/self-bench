import React from "react";
import { useParams } from "react-router";
import { useOrg } from "../SiteLayout";
import { benchmarkUrl, evaluationUrl } from "./api";

/**
 * Whose evaluations a page shows: a connected repository's, or a benchmark's (a Harbor registry
 * dataset the org added, run apart from any repository).
 */
export interface EvaluationScope {
  /** `owner/name`, for a repository's evaluations. */
  repo?: string;
  /** The API the evaluations are under. */
  url: string;
  /** Where their pages live: `/repos/<owner>/<name>`, or `/benchmarks/<org>/<name>`. */
  pages: string;
  /** What page titles name them by. */
  label: string;
}

const BenchmarkContext = React.createContext(false);

/** Puts the pages under it in the benchmark the route names, rather than a repository. */
export function BenchmarkScope({ children }: { children: React.ReactNode }) {
  return <BenchmarkContext.Provider value={true}>{children}</BenchmarkContext.Provider>;
}

export function useEvaluationScope(): EvaluationScope {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  const benchmark = React.useContext(BenchmarkContext);
  const full = `${owner}/${name}`;
  return benchmark
    ? { url: benchmarkUrl(org.login, full), pages: `/benchmarks/${full}`, label: full }
    : { repo: full, url: evaluationUrl(org.login, full), pages: `/repos/${full}`, label: full };
}
