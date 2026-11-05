import React from "react";
import { CardGridSkeleton } from "../LoadingSkeleton";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { Notice, PageFrame, PageHeader } from "../ui";
import {
  addBenchmark,
  type Benchmark,
  fetchBenchmarks,
  fetchRegistryDatasets,
  type RegistryDataset,
  removeBenchmark,
} from "./api";
import { BenchmarkList } from "./BenchmarkList";

/** How often boxes being added refresh. */
const POLL_MS = 3000;
const isAdding = (benchmark: Benchmark) => benchmark.status === "adding";

type Benchmarks = { status: "loading" } | { status: "ok"; benchmarks: Benchmark[] };

/** The org's benchmarks: Harbor registry datasets it runs models on, apart from its repositories. */
export function BenchmarksPage() {
  const { org } = useOrg();
  useDocumentTitle(`Public Benchmarks · ${org.login}`);
  const [benchmarks, setBenchmarks] = React.useState<Benchmarks>({ status: "loading" });
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setBenchmarks({ status: "loading" });
    fetchBenchmarks(org.login).then(
      (found) => !cancelled && setBenchmarks({ status: "ok", benchmarks: found }),
      (cause: Error) => !cancelled && setError(cause.message),
    );
    return () => {
      cancelled = true;
    };
  }, [org.login]);
  // While a worker adds a dataset, its box refreshes until it is ready or says why it failed.
  const adding = benchmarks.status === "ok" && benchmarks.benchmarks.some(isAdding);
  React.useEffect(() => {
    if (!adding) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      fetchBenchmarks(org.login).then(
        (found) => !cancelled && setBenchmarks({ status: "ok", benchmarks: found }),
        () => {},
      );
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [adding, org.login]);
  // Harbor's registry, fetched once the add box first opens and kept for the visit; a failure
  // is not kept, so opening the box again retries.
  const registry = React.useRef<{ org: string; datasets: Promise<RegistryDataset[]> }>(undefined);
  const loadRegistry = React.useCallback(() => {
    if (registry.current?.org !== org.login) {
      const datasets = fetchRegistryDatasets(org.login);
      registry.current = { org: org.login, datasets };
      datasets.catch(() => {
        if (registry.current?.datasets === datasets) registry.current = undefined;
      });
    }
    return registry.current.datasets;
  }, [org.login]);
  const add = async (reference: string) => {
    const benchmark = await addBenchmark(org.login, reference);
    setBenchmarks((current) =>
      current.status === "ok"
        ? {
            status: "ok",
            benchmarks: current.benchmarks.some((entry) => entry.name === benchmark.name)
              ? current.benchmarks.map((entry) =>
                  entry.name === benchmark.name ? benchmark : entry,
                )
              : [...current.benchmarks, benchmark],
          }
        : current,
    );
  };
  const remove = (benchmark: Benchmark) => {
    if (!window.confirm(`Remove ${benchmark.name}? Its runs stop showing here.`)) return;
    removeBenchmark(org.login, benchmark.name).then(
      () =>
        setBenchmarks((current) =>
          current.status === "ok"
            ? {
                status: "ok",
                benchmarks: current.benchmarks.filter((entry) => entry.name !== benchmark.name),
              }
            : current,
        ),
      (cause: Error) => setError(cause.message),
    );
  };
  return (
    <PageFrame>
      <PageHeader
        title="Public Benchmarks"
        description="Datasets from Harbor's registry that models run on, apart from your repositories."
      />
      {error && <Notice className="mb-4">{error}</Notice>}
      {benchmarks.status === "loading" && !error && <CardGridSkeleton label="Loading Benchmarks" />}
      {benchmarks.status === "ok" && (
        <BenchmarkList
          benchmarks={benchmarks.benchmarks}
          onAdd={add}
          onRemove={remove}
          loadRegistry={loadRegistry}
        />
      )}
    </PageFrame>
  );
}
