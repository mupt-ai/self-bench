import { ChevronDown } from "lucide-react";
import { cn } from "../primitives/cn";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../primitives/dropdown-menu";
import {
  type ConfigurationColumn,
  type Facet,
  facets,
  facetValues,
  matchingFacets,
} from "./configuration-facets";
import { RunStateFilter } from "./ResultsFilters";
import { type RunState, SortIcon } from "./ResultsMarks";
import type { Configuration } from "./results-model";
import { configurationColor } from "./results-presentation";
import type { Order } from "./results-view";

/**
 * A facet's filter: a button reading "All Vendors" until values are chosen, then the facet and
 * the first of them, with how many more. It opens to a checklist of every value, each with how
 * many configurations have it given the other facets' choices, and stays open while values are
 * checked. Any of a facet's values may match; every facet must. A vendor carries its color.
 */
function FacetMenu({
  facet,
  configurations,
  chosen,
  onToggle,
  onClear,
}: {
  facet: Facet;
  configurations: readonly Configuration[];
  chosen: Readonly<Record<string, readonly string[]>>;
  onToggle(facet: string, value: string): void;
  onClear(facet: string): void;
}) {
  const picked = chosen[facet.key] ?? [];
  const { [facet.key]: _, ...others } = chosen;
  const candidates = matchingFacets(configurations, others);
  const values = [...new Set([...facetValues(facet, configurations), ...picked])];
  const count = (entry: string) =>
    candidates.filter((configuration) => facet.values(configuration).includes(entry)).length;
  const color = (entry: string) => {
    const configuration = configurations.find((item) => facet.values(item).includes(entry));
    return facet.key === "vendor" && configuration ? configurationColor(configuration) : undefined;
  };
  const [first] = picked;
  // Choosing keeps the menu open, so several values can be checked in one go.
  const stayOpen = (event: Event) => event.preventDefault();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={picked.length ? `${facet.label}: ${picked.join(", ")}` : facet.all}
          className={cn(
            "group flex h-8 items-center gap-2 border bg-card px-3 text-xs font-semibold whitespace-nowrap hover:border-foreground/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15",
            first ? "border-foreground/50 text-foreground" : "border-border text-muted-foreground",
          )}
        >
          {first ? (
            <>
              <span className="font-medium text-muted-foreground">{facet.label}</span>
              {color(first) && (
                <span className="size-2" style={{ background: color(first) }} aria-hidden="true" />
              )}
              {first}
              {picked.length > 1 && (
                <span className="font-mono font-medium text-muted-foreground">
                  +{picked.length - 1}
                </span>
              )}
            </>
          ) : (
            facet.all
          )}
          <ChevronDown
            className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-52 p-1.5" aria-label={facet.label}>
        <DropdownMenuCheckboxItem
          checked={!picked.length}
          onSelect={stayOpen}
          onCheckedChange={() => onClear(facet.key)}
          className="gap-2.5 text-xs data-[state=checked]:bg-foreground/[0.04]"
        >
          <span className="size-2 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium">{facet.all}</span>
          <span className="font-mono text-muted-foreground tabular-nums">{candidates.length}</span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {values.map((entry) => (
          <DropdownMenuCheckboxItem
            key={entry}
            checked={picked.includes(entry)}
            onSelect={stayOpen}
            onCheckedChange={() => onToggle(facet.key, entry)}
            className={cn(
              "gap-2.5 text-xs data-[state=checked]:bg-foreground/[0.04]",
              // Nothing to show with the other choices: still choosable, but quiet.
              !count(entry) && "text-muted-foreground",
            )}
          >
            <span
              className="size-2 shrink-0"
              style={{ background: color(entry) }}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate font-medium">{entry}</span>
            <span className="font-mono text-muted-foreground tabular-nums">{count(entry)}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Above the table: a filter per facet (vendor, provider, reasoning, harness), then toggles for
 * each configuration state.
 */
export function ConfigurationToolbar({
  configurations,
  states,
  chosenStates,
  chosen,
  onToggleState,
  onToggleFacet,
  onClearFacet,
}: {
  configurations: readonly Configuration[];
  /** The state of each configuration the facets leave, for the toggles' counts. */
  states: readonly RunState[];
  chosenStates: ReadonlySet<RunState>;
  chosen: Readonly<Record<string, readonly string[]>>;
  onToggleState(state: RunState): void;
  onToggleFacet(facet: string, value: string): void;
  onClearFacet(facet: string): void;
}) {
  const any = Object.values(chosen).some((values) => values.length > 0);
  return (
    <div className="mb-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {facets.map((facet) => (
          <FacetMenu
            key={facet.key}
            facet={facet}
            configurations={configurations}
            chosen={chosen}
            onToggle={onToggleFacet}
            onClear={onClearFacet}
          />
        ))}
        {any && (
          <button
            type="button"
            className="h-8 px-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
            onClick={() => {
              for (const facet of facets) onClearFacet(facet.key);
            }}
          >
            Clear Filters
          </button>
        )}
      </div>
      <RunStateFilter states={states} selected={chosenStates} onToggle={onToggleState} />
    </div>
  );
}

/** A table heading that sorts by its column: ascending, then descending, then off. */
export function ColumnHeading({
  label,
  column,
  order,
  className,
  onSort,
}: {
  label: string;
  column: ConfigurationColumn;
  order: Order<ConfigurationColumn> | undefined;
  className?: string;
  onSort(column: ConfigurationColumn): void;
}) {
  const active = order?.by === column ? (order.descending ? "descending" : "ascending") : undefined;
  return (
    <th className={cn("text-right", className)} aria-sort={active ?? "none"}>
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1 font-semibold hover:text-foreground",
          active && "text-foreground",
        )}
        onClick={() => onSort(column)}
      >
        {label}
        <SortIcon order={active} />
      </button>
    </th>
  );
}
