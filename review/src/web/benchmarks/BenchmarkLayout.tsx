import { BenchmarkScope } from "../evaluation/useEvaluationScope";
import { ScopeLayout } from "../ScopeLayout";

/**
 * One benchmark: a Harbor registry dataset the org added, with a repository's Dataset, Run,
 * Results, and Releases pages. Its tasks are frozen from the registry, so it has none of the tabs
 * that edit them.
 */
export function BenchmarkLayout() {
  return (
    <BenchmarkScope>
      <ScopeLayout afterResults={[{ path: "/releases", label: "Releases" }]} />
    </BenchmarkScope>
  );
}
