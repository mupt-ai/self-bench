import { Ellipsis, Package } from "lucide-react";
import { useRef } from "react";
import { Link } from "react-router";
import { formatAgo } from "../api";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../primitives/dropdown-menu";
import { Button } from "../ui";
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
  const trigger = useRef<HTMLButtonElement>(null);
  const pendingRemove = useRef(false);
  return (
    <article className="panel group relative flex h-full min-h-40 flex-col transition-[border-color,box-shadow] hover:border-foreground/30 hover:shadow-[0_2px_4px_rgb(0_0_0/0.06),0_10px_24px_-8px_rgb(0_0_0/0.14)] has-[a:focus-visible]:border-foreground/40">
      <Link
        aria-label={`Open ${benchmark.name}`}
        className="absolute inset-0 z-0 focus-visible:outline-none!"
        to={`/benchmarks/${benchmark.name}`}
      />
      <header className="pointer-events-none relative z-10 flex items-center gap-2.5 px-4 pt-4">
        <Package className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate font-mono text-sm font-medium">{benchmark.name}</h2>
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) pendingRemove.current = false;
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              ref={trigger}
              size="icon"
              variant="ghost"
              className="pointer-events-auto -my-1 -mr-2 h-8 w-8 text-muted-foreground hover:text-foreground"
              aria-label={`Actions for ${benchmark.name}`}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            onCloseAutoFocus={(event) => {
              if (!pendingRemove.current) return;
              event.preventDefault();
              pendingRemove.current = false;
              trigger.current?.focus();
              onRemove(benchmark);
            }}
          >
            <DropdownMenuItem
              className="text-destructive data-[highlighted]:text-destructive"
              onSelect={() => {
                pendingRemove.current = true;
              }}
            >
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <p className="pointer-events-none relative z-10 mt-2 flex items-center gap-x-2 truncate px-4 text-xs text-muted-foreground">
        <span>Harbor Registry</span>
        <span aria-hidden="true">·</span>
        <span>Added {formatAgo(benchmark.addedAt)}</span>
      </p>
      <dl className="pointer-events-none relative z-10 mt-auto grid grid-cols-3 border-t border-border">
        <Stat label="Tasks" value={benchmark.tasks} />
        <Stat label="Runs" value={benchmark.runs} />
        <Stat label="Version" value={benchmark.ref} />
      </dl>
    </article>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-r border-border px-4 py-3 last:border-r-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-sm font-medium text-foreground tabular-nums">
        {value}
      </dd>
    </div>
  );
}
