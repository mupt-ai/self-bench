import { harnessLabels } from "../../../../src/evaluation/models";
import { vendorName } from "../../public-site/format";
import { providers } from "./credential-presentation";
import type { Configuration } from "./results-model";
import type { Order } from "./results-view";

/**
 * Narrowing and ordering the Results table's configurations: by vendor, provider, reasoning and
 * harness, and by how much is done, the pass rate, or the cost per task.
 */

export interface Facet {
  key: "vendor" | "provider" | "reasoning" | "harness";
  label: string;
  /** What the filter reads when nothing is chosen. */
  all: string;
  value(configuration: Configuration): string;
}

const reasoningNames: Record<string, string> = { default: "Model Default", xhigh: "X-High" };

export const facets: Facet[] = [
  {
    key: "vendor",
    label: "Vendor",
    all: "All Vendors",
    value: (configuration) =>
      vendorName({ provider: configuration.provider, model: { name: configuration.modelName } }),
  },
  {
    key: "provider",
    label: "Provider",
    all: "All Providers",
    value: (configuration) =>
      providers.find((entry) => entry.id === configuration.provider)?.label ??
      configuration.provider,
  },
  {
    key: "reasoning",
    label: "Reasoning",
    all: "All Reasoning Levels",
    value: ({ thinking }) =>
      !thinking
        ? "Not Recorded"
        : (reasoningNames[thinking] ?? thinking.charAt(0).toUpperCase() + thinking.slice(1)),
  },
  {
    key: "harness",
    label: "Harness",
    all: "All Harnesses",
    value: (configuration) =>
      harnessLabels[configuration.harness as keyof typeof harnessLabels] ?? configuration.harness,
  },
];

/**
 * Each facet's values among some configurations, in alphabetical order, with custom models and
 * endpoints last, as the charts' vendor chips put them.
 */
export function facetValues(facet: Facet, configurations: readonly Configuration[]): string[] {
  const custom = (value: string) => (value.startsWith("Custom") ? 1 : 0);
  return [...new Set(configurations.map(facet.value))].sort(
    (a, b) => custom(a) - custom(b) || a.localeCompare(b),
  );
}

/**
 * The configurations every facet allows: a facet allows any of its chosen values (Anthropic or
 * OpenAI), all facets must allow it (and High), and a facet with none chosen allows everything.
 */
export function matchingFacets(
  configurations: readonly Configuration[],
  chosen: Readonly<Record<string, readonly string[]>>,
): Configuration[] {
  return configurations.filter((configuration) =>
    facets.every((facet) => {
      const values = chosen[facet.key] ?? [];
      return !values.length || values.includes(facet.value(configuration));
    }),
  );
}

export type ConfigurationColumn = "done" | "pass" | "cost";

/** A column's value for sorting; undefined sorts last either way. */
function columnValue(
  configuration: Configuration,
  column: ConfigurationColumn,
  total: (configuration: Configuration) => number,
) {
  switch (column) {
    case "done": {
      const tasks = total(configuration);
      return tasks ? configuration.finished / tasks : undefined;
    }
    case "pass":
      return configuration.passRate;
    case "cost":
      return configuration.costPerTask;
  }
}

/** The configurations ordered by a column, or as they came (most recently run first). */
export function orderedConfigurations(
  configurations: readonly Configuration[],
  order: Order<ConfigurationColumn> | undefined,
  /** How many tasks the Done column counts against: those run, unless told every accepted one. */
  total: (configuration: Configuration) => number = (configuration) => configuration.latest.length,
): Configuration[] {
  if (!order) return [...configurations];
  return [...configurations].sort((a, b) => {
    const [x, y] = [columnValue(a, order.by, total), columnValue(b, order.by, total)];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? 1 : -1;
    return order.descending ? y - x : x - y;
  });
}
