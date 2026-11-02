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
        <AddBenchmarkCard added={benchmarks.map((benchmark) => benchmark.name)} onAdd={onAdd} />
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
  return (
    <ScopeCard
      name={benchmark.name}
      to={`/benchmarks/${benchmark.name}`}
      icon={<Package className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />}
      details={["Harbor Registry", `Added ${formatAgo(benchmark.addedAt)}`]}
      stats={[
        { label: "Tasks", value: benchmark.tasks },
        { label: "Runs", value: benchmark.runs },
        { label: "Version", value: benchmark.ref },
      ]}
      removeLabel="Remove"
      onRemove={() => onRemove(benchmark)}
    />
  );
}
