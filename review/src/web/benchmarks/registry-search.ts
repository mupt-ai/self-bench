import {
  MAX_REGISTRY_TASKS,
  type RegistryDataset,
} from "../../../../src/contracts/harbor-registry";
import { matchesQuery } from "../word-search";

/** Widely used datasets, listed first before anything is typed and ahead of equal matches. */
const POPULAR = [
  "terminal-bench/terminal-bench-2",
  "swe-bench/swe-bench-verified",
  "aider/aider-polyglot",
  "featurebench/featurebench-lite",
  "harbor/hello-world",
];

/** The most results the list draws; typing more narrows it. */
const MOST_SHOWN = 50;

/** The part of what was typed that names a dataset: `org/name@ref` searches as `org/name`. */
function datasetQuery(typed: string): string {
  return typed.trim().replace(/@.*$/, "");
}

/** Why a listed dataset can't be picked, shown in its place in the list, or nothing when it can. */
export function datasetBlock(
  dataset: RegistryDataset,
  added: readonly string[],
): string | undefined {
  if (added.includes(dataset.name)) return "Added";
  if (dataset.tasks > MAX_REGISTRY_TASKS) return `Over ${MAX_REGISTRY_TASKS} tasks`;
  return undefined;
}

/**
 * How well a dataset matches: its name exactly, the start of its `org/name`, the start of the
 * part after the org, a word of its name, then only its description. Lower is better; undefined
 * is no match. So "terminal" lists terminal-bench's own datasets before others' copies.
 */
function rank(dataset: RegistryDataset, query: string): number | undefined {
  const name = dataset.name.toLowerCase();
  const typed = query.toLowerCase();
  const short = name.split("/")[1] ?? "";
  if (name === typed || short === typed) return 0;
  if (name.startsWith(typed)) return 1;
  if (short.startsWith(typed)) return 2;
  if (matchesQuery(dataset.name, query)) return 3;
  if (matchesQuery(`${dataset.name} ${dataset.description ?? ""}`, query)) return 4;
  return undefined;
}

const popularity = (name: string) => {
  const index = POPULAR.indexOf(name);
  return index === -1 ? POPULAR.length : index;
};

/**
 * The datasets a search shows, best first: each word typed must start a word of the dataset's
 * name or description, in any order, ignoring case and accents. Before anything is typed, the
 * popular datasets come first, then the rest by name.
 */
export function searchRegistry(
  datasets: readonly RegistryDataset[],
  typed: string,
): RegistryDataset[] {
  const query = datasetQuery(typed);
  const ranked: { dataset: RegistryDataset; score: number }[] = [];
  for (const dataset of datasets) {
    const score = query ? rank(dataset, query) : 0;
    if (score !== undefined) ranked.push({ dataset, score });
  }
  return ranked
    .sort(
      (left, right) =>
        left.score - right.score ||
        popularity(left.dataset.name) - popularity(right.dataset.name) ||
        left.dataset.name.localeCompare(right.dataset.name),
    )
    .slice(0, MOST_SHOWN)
    .map((entry) => entry.dataset);
}
