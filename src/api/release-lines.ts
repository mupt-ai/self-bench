import type { ArtifactStore } from "../artifacts/index.js";
import type { BenchmarkStore } from "../db/benchmarks.js";
import type { Database } from "../db/client.js";
import type { GroupStore } from "../db/groups.js";
import type { ReleaseStore } from "../db/releases.js";
import type { RepoStore } from "../db/repos.js";
import type { UserStore } from "../db/users.js";
import { createBenchmarkReleaseRoutes } from "./routes/benchmark-releases.js";
import { createGroupReleaseRoutes } from "./routes/group-releases.js";
import { createReleaseRoutes } from "./routes/releases.js";

/**
 * The Releases tabs of each kind of line: a connected repository's, a repository group's, and a
 * public benchmark's. Each tells `publicChanged` the selfbench.dev pages its release or withdrawal
 * changed, which reads the public lines afresh and tells search engines.
 */
export function releaseLineRoutes(deps: {
  db: Database;
  artifacts: ArtifactStore;
  users: UserStore;
  repos: RepoStore;
  groups: GroupStore;
  benchmarks: BenchmarkStore;
  releases: ReleaseStore;
  publicUrl: string;
  resultsSiteUrl: string | null;
  githubApiUrl: string;
  publicChanged(paths: string[]): void;
}) {
  const { publicChanged, ...shared } = deps;
  return {
    releases: createReleaseRoutes({
      ...shared,
      // The repository's page, the publisher's line, and the home page's directory.
      onPublicChange: ({ fullName, publisher }) =>
        publicChanged(["/", `/${fullName}`, `/${fullName}/${publisher}`]),
    }),
    groupReleases: createGroupReleaseRoutes({ ...shared, onPublicChange: publicChanged }),
    benchmarkReleases: createBenchmarkReleaseRoutes({ ...shared, onPublicChange: publicChanged }),
  };
}
