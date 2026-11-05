import { Package } from "lucide-react";
import { formatAgo } from "../api";
import { ScopeCard } from "../ScopeCard";
import { AddBenchmarkCard } from "./AddBenchmarkCard";
import type { Benchmark } from "./api";

/** The org's benchmarks as boxes, like its repositories, with a box to add another. */
export function BenchmarkList({
  benchmarks,
  onAdd,
  onRemove,
}: {
  benchmarks: Benchmark[];
  onAdd(reference: string): Promise<void>;
  onRemove(benchmark: Benchmark): void;
}) {
  return (
    <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {benchmarks.map((benchmark) => (
        <li key={benchmark.name}>
          <BenchmarkCard benchmark={benchmark} onRemove={onRemove} />
        </li>
      ))}
      <li>
        {/* A failed box can be added again, which retries it; only the others are taken. */}
        <AddBenchmarkCard
          added={benchmarks.flatMap((benchmark) =>
            benchmark.status === "failed" ? [] : [benchmark.name],
          )}
          onAdd={onAdd}
        />
      </li>
    </ul>
  );
}

function BenchmarkCard({
  benchmark,
  onRemove,
}: {
  benchmark: Benchmark;
  onRemove(benchmark: Benchmark): void;
}) {
  const ready = benchmark.status === "ready";
  return (
    <ScopeCard
      name={benchmark.name}
      {...(ready ? { to: `/benchmarks/${benchmark.name}` } : {})}
      icon={<Package className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      details={[
        "Harbor Registry",
        benchmark.status === "adding"
          ? "Downloading and checking tasks…"
          : benchmark.status === "failed"
            ? "Couldn't be added"
            : `Added ${formatAgo(benchmark.addedAt)}`,
      ]}
      stats={[
        // Unknown until a worker has checked them; the box shows them loading meanwhile.
        { label: "Tasks", ...(ready ? { value: benchmark.tasks } : {}) },
        { label: "Runs", value: benchmark.runs },
        { label: "Version", value: benchmark.ref },
      ]}
      {...(benchmark.status === "failed"
        ? { notice: benchmark.error ?? "Dataset could not be added" }
        : {})}
      removeLabel="Remove"
      onRemove={() => onRemove(benchmark)}
    />
  );
}
