import type { PublishedLine } from "../../../src/public/release-types";
import type { PublicRepoPage } from "./contract";
import { memorySource, type PublicSource } from "./source";

/** The server answered with an error; pages show their error state. */
class PublicApiError extends Error {}

/** Every current release the API returned, as pages for the in-memory source. */
async function linesFrom(url: string): Promise<PublicRepoPage[]> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (response.status === 404) return [];
  if (!response.ok) throw new PublicApiError(`public API answered ${response.status}`);
  const { lines } = (await response.json()) as { lines: PublishedLine[] };
  // The source fills `lines` from the other lines of the same repository.
  return lines.map((line) => ({ release: line.release, endorsed: line.endorsed, lines: [] }));
}

/**
 * The live source: the server's public release routes. The directory reads every line's current
 * release at once; a repository page reads only its own lines. `memorySource` then picks default
 * lines and summaries exactly as it does for fixtures.
 */
export function apiSource(base = ""): PublicSource {
  // The home page asks for repositories and lines together; concurrent callers share one
  // request, and the next call after it settles fetches again.
  let directory: Promise<PublicSource> | undefined;
  const everything = () => {
    if (!directory) {
      const request = linesFrom(`${base}/api/public/releases`).then(memorySource);
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
    listRepos: async () => (await everything()).listRepos(),
    listLines: async () => (await everything()).listLines(),
    getRepo: async (owner, name) => (await repository(owner, name)).getRepo(owner, name),
    getLine: async (owner, name, publisher) =>
      (await repository(owner, name)).getLine(owner, name, publisher),
  };
}
