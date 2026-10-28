import { ChevronDown, ListChecks } from "lucide-react";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { SettingsPicker } from "../releases/SettingsPicker";
import { Button } from "../ui";
import type { ChartOption } from "./results-chart";

/**
 * The configurations chosen for the chart, kept for the session per repository. The header's card
 * and the phone's button are both mounted, so they read one store and agree.
 */
const chosenStore = {
  memory: new Map<string, string | null>(),
  listeners: new Set<() => void>(),
  read(key: string): string | null {
    if (this.memory.has(key)) return this.memory.get(key) ?? null;
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  write(key: string, value: string | null) {
    this.memory.set(key, value);
    try {
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch {}
    for (const listener of this.listeners) listener();
  },
  subscribe(listener: () => void) {
    chosenStore.listeners.add(listener);
    return () => chosenStore.listeners.delete(listener);
  },
};

/** The chosen configurations' keys, undefined until something is chosen, and how to choose. */
export function useChosen(
  /** The repository's evaluations URL, which names its org too. */
  url: string,
  /** What they are chosen for: the chart, or Model Summaries, which keeps a choice of its own. */
  purpose: "chart" | "summary" = "chart",
): [string[] | undefined, (keys: string[] | undefined) => void] {
  const key = `selfbench-${purpose}-configurations:${url}`;
  const read = () => chosenStore.read(key);
  const raw = useSyncExternalStore(chosenStore.subscribe, read, read);
  const chosen = useMemo(() => {
    try {
      const saved: unknown = JSON.parse(raw ?? "null");
      return Array.isArray(saved)
        ? saved.filter((entry): entry is string => typeof entry === "string")
        : undefined;
    } catch {
      return undefined;
    }
  }, [raw]);
  const choose = useCallback(
    (keys: string[] | undefined) => chosenStore.write(key, keys ? JSON.stringify(keys) : null),
    [key],
  );
  return [chosen, choose];
}

/** The chart's configurations: what's chosen, and, opened, the picker to change it. */
export function ChartConfigurations({
  options,
  tasks,
  chosen,
  custom,
  summary,
  legend = "Configurations to Chart",
  choose,
}: {
  options: readonly ChartOption[];
  /** How many accepted tasks there are, for each configuration's coverage. */
  tasks: number;
  chosen: readonly ChartOption[];
  /** Whether something was chosen, rather than the default. */
  custom: boolean;
  /** What the chosen configurations chart over. */
  summary: string;
  /** The picker's name. */
  legend?: string;
  choose(keys: string[] | undefined): void;
}) {
  const [query, setQuery] = useState("");
  const ticked = new Set(chosen.map((option) => option.configuration.key));
  return (
    <details className="group panel mb-4">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
        <ListChecks className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            {chosen.length} {chosen.length === 1 ? "Configuration" : "Configurations"}
          </span>
          <span className="mt-1 block text-xs text-muted-foreground">{summary}</span>
        </span>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {chosen.length} of {options.length} Chosen
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="space-y-3 border-t border-border p-4">
        <div className="flex flex-wrap gap-2">
          <Button
            size="small"
            onClick={() => choose(options.map((option) => option.configuration.key))}
          >
            Select All
          </Button>
          <Button size="small" onClick={() => choose([])}>
            Clear All
          </Button>
          <Button size="small" disabled={!custom} onClick={() => choose(undefined)}>
            Use Default
          </Button>
        </div>
        <SettingsPicker
          settings={options.map(({ configuration, coverage }) => ({
            key: configuration.key,
            label: configuration.label,
            harness: configuration.harness,
            ...(configuration.thinking ? { reasoningLevel: configuration.thinking } : {}),
            covered: coverage.size,
          }))}
          tasks={tasks}
          ticked={ticked}
          query={query}
          disabled={false}
          noun="Configurations"
          legend={legend}
          onQuery={setQuery}
          onChange={(next) =>
            // In the order offered, so the same boxes are the same choice.
            choose(options.map((option) => option.configuration.key).filter((key) => next.has(key)))
          }
        />
      </div>
    </details>
  );
}
