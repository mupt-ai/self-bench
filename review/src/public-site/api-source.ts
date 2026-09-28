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

/** One repository's current releases, as pages for the in-memory source. */
async function linesFrom(url: string): Promise<PublicRepoPage[]> {
  const { lines } = (await read<{ lines: PublishedLine[] }>(url)) ?? { lines: [] };
  // The source fills `lines` from the other lines of the same repository.
  return lines.map((line) => ({ release: line.release, endorsed: line.endorsed, lines: [] }));
}

/**
 * The live source: the server's public release routes. The directory reads every line's card,
 * already reduced to what a card shows; a repository page reads only its own lines, and
 * `memorySource` picks its default line exactly as it does for fixtures.
 */
export function apiSource(base = ""): PublicSource {
  // The home page asks for repositories and lines together; concurrent callers share one
  // request, and the next call after it settles fetches again.
  let directory: Promise<PublicRepoSummary[]> | undefined;
  const everything = () => {
    if (!directory) {
      const request = read<{ cards: PublicRepoSummary[] }>(`${base}/api/public/directory`).then(
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
        `${base}/api/public/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
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
