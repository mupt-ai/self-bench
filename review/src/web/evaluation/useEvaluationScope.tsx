import React from "react";
import { useParams } from "react-router";
import { groupsUrl } from "../groups/api";
import { useOrg } from "../SiteLayout";
import { benchmarkUrl, evaluationUrl } from "./api";

/**
 * Whose evaluations a page shows: a connected repository's, or a benchmark's (a Harbor registry
 * dataset the org added). Both have the same Dataset, Run, and Results pages; a repository also
 * edits its tasks, which is all `repo` is for.
 */
export interface EvaluationScope {
  kind: "repository" | "benchmark" | "group";
  /** `owner/name`, for a repository's evaluations: what only a repository has reads it. */
  repo?: string;
  /** The API the evaluations are under. */
  url: string;
  /** Where their pages live: `/repos/<owner>/<name>`, `/benchmarks/<org>/<name>`, `/groups/<slug>`. */
  pages: string;
  /** What page titles and breadcrumbs name them by. */
  label: string;
  /** The list the scope belongs to, for breadcrumbs. */
  parent: { label: string; to: string };
}

const BenchmarkContext = React.createContext(false);
const GroupContext = React.createContext(false);

/** Puts the pages under it in the benchmark the route names, rather than a repository. */
export function BenchmarkScope({ children }: { children: React.ReactNode }) {
  return <BenchmarkContext.Provider value={true}>{children}</BenchmarkContext.Provider>;
}

/** Puts the pages under it in the repository group the route names (`:slug`). */
export function GroupScope({ children }: { children: React.ReactNode }) {
  return <GroupContext.Provider value={true}>{children}</GroupContext.Provider>;
}

export function useEvaluationScope(): EvaluationScope {
  const { org } = useOrg();
  const { owner = "", name = "", slug = "" } = useParams();
  const benchmark = React.useContext(BenchmarkContext);
  const group = React.useContext(GroupContext);
  const full = `${owner}/${name}`;
  if (group)
    return {
      kind: "group",
      url: groupsUrl(org.login, slug, "/evaluations"),
      pages: `/groups/${slug}`,
      label: slug,
      parent: { label: "Repository Groups", to: "/groups" },
    };
  return benchmark
    ? {
        kind: "benchmark",
        url: benchmarkUrl(org.login, full),
        pages: `/benchmarks/${full}`,
        label: full,
        parent: { label: "Public Benchmarks", to: "/benchmarks" },
      }
    : {
        kind: "repository",
        repo: full,
        url: evaluationUrl(org.login, full),
        pages: `/repos/${full}`,
        label: full,
        parent: { label: "Repositories", to: "/" },
      };
}
