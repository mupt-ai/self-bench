import type { PublishedLine } from "../../../src/public/release-types";
import type { PublicRepoPage, PublicRepoSummary } from "./contract";
import { memorySource, type PublicSource } from "./source";

/** The server answered with an error; pages show their error state. */
class PublicApiError extends Error {}

/** A public API response, or undefined when it answers 404. */
async function read<T>(url: string): Promise<T | undefined> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new PublicApiError(`public API answered ${response.status}`);
  return (await response.json()) as T;
}

/**
 * The API response the server carried in the page for its first render (src/api/site-body.ts),
 * by the address it answers. It is read once and removed, so only the page the browser loaded
 * uses it; every later page reads the API.
 */
function carriedData(): Map<string, unknown> {
  const carried = new Map<string, unknown>();
  const element = typeof document === "undefined" ? null : document.getElementById("page-data");
  const url = element?.dataset.url;
  if (element && url) {
    try {
      carried.set(url, JSON.parse(element.textContent ?? ""));
    } catch {
      // A block that does not parse is left unused: the page reads the API as it would anyway.
    }
    element.remove();
  }
  return carried;
}

/** One repository's current releases, as pages for the in-memory source. */
async function linesFrom(
  answer: Promise<{ lines: PublishedLine[] } | undefined>,
): Promise<PublicRepoPage[]> {
  const { lines } = (await answer) ?? { lines: [] };
  // The source fills `lines` from the other lines of the same repository.
  return lines.map((line) => ({ release: line.release, endorsed: line.endorsed, lines: [] }));
}

/**
 * The live source: the server's public release routes. The directory reads every line's card,
 * already reduced to what a card shows; a repository page reads only its own lines, and
 * `memorySource` picks its default line exactly as it does for fixtures.
 */
export function apiSource(base = "", carried = carriedData()): PublicSource {
  /** `url`'s response: the page's carried copy the first time, else the API's. */
  const answer = async <T>(url: string): Promise<T | undefined> => {
    if (!carried.has(url)) return read<T>(url);
    const value = carried.get(url) as T;
    carried.delete(url);
    return value;
  };
  // The home page asks for repositories and lines together; concurrent callers share one
  // request, and the next call after it settles fetches again.
  let directory: Promise<PublicRepoSummary[]> | undefined;
  const everything = () => {
    if (!directory) {
      const request = answer<{ cards: PublicRepoSummary[] }>(`${base}/api/public/directory`).then(
        (answer) => answer?.cards ?? [],
      );
      const settled = () => {
        if (directory === request) directory = undefined;
      };
      request.then(settled, settled);
      directory = request;
    }
    return directory;
  };
  const repository = async (owner: string, name: string) =>
    memorySource(
      await linesFrom(
        answer(`${base}/api/public/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`),
      ),
    );
  return {
    listRepos: async () => (await everything()).filter((card) => card.defaultLine),
    listLines: async () => everything(),
    getRepo: async (owner, name) => (await repository(owner, name)).getRepo(owner, name),
    getLine: async (owner, name, publisher) =>
      (await repository(owner, name)).getLine(owner, name, publisher),
  };
}
