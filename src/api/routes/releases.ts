import type { ArtifactStore } from "../../artifacts/index.js";
import { buildCommit } from "../../contracts/config/build-metadata.js";
import type { Database } from "../../db/client.js";
import type { ReleaseLine, ReleaseStore } from "../../db/releases.js";
import { type GitHubRepo, isGitHubRepo, type RepoStore } from "../../db/repos.js";
import type { UserStore } from "../../db/users.js";
import { catalogVersion } from "../../evaluation/catalog.js";
import { readModelSummaries } from "../../evaluation/model-summary.js";
import { track } from "../../lib/telemetry/posthog.js";
import {
  type GitHubRepository,
  lookupRepositoryById,
  releaseInputs,
} from "../../public/release-sources.js";
import { GitHubOAuthError } from "../../third_party/github/oauth.js";
import {
  buildRequested,
  createLineRoutes,
  isReply,
  type LineKind,
  publisherOf,
} from "./release-line.js";

const NAME = "[A-Za-z0-9_.-]+";
/** `[org, owner/name, section?, action?]`. */
const route = new RegExp(
  `^/api/orgs/(${NAME})/repos/(${NAME}/${NAME})/releases(?:/(preview|[a-f0-9-]{36}))?(?:/(withdraw))?$`,
);

export interface ReleaseRoutesOptions {
  readonly db: Database;
  readonly artifacts: ArtifactStore;
  readonly users: UserStore;
  readonly repos: RepoStore;
  readonly releases: ReleaseStore;
  readonly publicUrl: string;
  readonly githubApiUrl: string;
  /** Origin of the results site, for links to released pages; null when there is none. */
  readonly resultsSiteUrl: string | null;
  readonly fetchImpl?: typeof fetch;
  /**
   * Told when what the public sees changes (a release or a withdrawal), and for which repository
   * and publisher, so it is read afresh and search engines can be told which pages changed.
   */
  readonly onPublicChange?: (change: PublicChange) => void;
}

/** What a release or withdrawal changed on selfbench.dev: one publisher's line of a repository. */
export interface PublicChange {
  fullName: string;
  publisher: string;
}

/**
 * A connected repository's releases on selfbench.dev: its results for the settings the releaser
 * ticks, and optionally its tasks, each setting's trial on them, and its Model Summaries.
 */
export function createReleaseRoutes(options: ReleaseRoutesOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const line = (repo: GitHubRepo): ReleaseLine => ({
    orgId: repo.orgId,
    githubRepoId: repo.githubId,
  });
  const kind: LineKind<GitHubRepo> = {
    route,
    notFound: "Repository is not connected here",
    // An eval has no repository on GitHub, so it is never released to selbench.dev.
    find: async (tenant, fullName) => {
      const repo = await options.repos.find(tenant.id, fullName);
      return repo && isGitHubRepo(repo) ? repo : undefined;
    },
    lineOf: (_tenant, repo) => line(repo),
    async gather(tenant, repo, rows) {
      const [inputs, { report }] = await Promise.all([
        releaseInputs(options.db, options.artifacts, { repoId: repo.id, orgId: tenant.id }, rows),
        readModelSummaries(options.artifacts, { repoId: repo.id }),
      ]);
      return { inputs, ...(report ? { report } : {}) };
    },
    async build({ tenant, subject: repo, token, body, gathered }) {
      let github: GitHubRepository | undefined;
      try {
        github = await lookupRepositoryById(options.githubApiUrl, token, repo.githubId, fetchImpl);
      } catch (error) {
        if (!(error instanceof GitHubOAuthError)) throw error;
        return [
          503,
          {
            error: "GitHub could not confirm that the repository is public. Try again in a moment.",
          },
        ];
      }
      // Checked live: the repository may have turned private since it was connected.
      if (!github || github.private)
        return [400, { error: "Only public repositories can be released." }];
      const built = buildRequested(gathered, body, {
        repository: { id: github.id, fullName: github.fullName },
        publisher: { login: tenant.login, kind: tenant.kind },
      });
      if (isReply(built)) return built;
      const { private: isPrivate, archived, ...repository } = github;
      return {
        fullName: github.fullName,
        hash: built.hash,
        payload: {
          ...built.payload,
          repository: { ...repository, ...built.payload.repository },
          publisher: publisherOf(tenant),
        },
        detail: {
          ...built.detail,
          provenance: { selfbenchBuild: buildCommit, catalogVersion },
          repositoryFlags: { private: isPrivate, archived },
        },
      };
    },
    changed(tenant, row, user, released) {
      options.onPublicChange?.({ fullName: row.fullName, publisher: row.publisherLogin });
      if (released) track(user, "release published", { repo: row.fullName }, tenant);
    },
  };
  return createLineRoutes(options, kind);
}
export type ReleaseRoutes = ReturnType<typeof createReleaseRoutes>;
