import type { ArtifactStore } from "../../artifacts/index.js";
import { buildCommit } from "../../contracts/config/build-metadata.js";
import type { Database } from "../../db/client.js";
import type { EvalLine, ReleaseLine, ReleaseStore } from "../../db/releases.js";
import { type ConnectedRepo, isGitHubRepo, type RepoStore } from "../../db/repos.js";
import type { Org, UserStore } from "../../db/users.js";
import { catalogVersion } from "../../evaluation/catalog.js";
import { readModelSummaries } from "../../evaluation/model-summary.js";
import { track } from "../../lib/telemetry/posthog.js";
import { type BuiltRelease, buildRelease, ReleaseRefused } from "../../public/release-build.js";
import {
  type GitHubRepository,
  lookupRepositoryById,
  releaseInputs,
} from "../../public/release-sources.js";
import { GitHubOAuthError } from "../../third_party/github/oauth.js";
import { createLineRoutes, type LineKind } from "./release-line.js";

type BuildContext = Parameters<LineKind<ConnectedRepo>["build"]>[0];

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
 * A connected repository's or eval's releases on selfbench.dev: its results for the settings the
 * releaser ticks, and optionally its Model Summaries and, for a repository, its tasks and each
 * setting's trial on them.
 */
export function createReleaseRoutes(options: ReleaseRoutesOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const line = (repo: ConnectedRepo): ReleaseLine | EvalLine =>
    isGitHubRepo(repo)
      ? { orgId: repo.orgId, githubRepoId: repo.githubId }
      : { orgId: repo.orgId, evalRepoId: repo.id };
  /**
   * An eval's release: its scores, and optionally its Model Summaries, under its `evals/<slug>`
   * name. Its tasks are scenarios with no public repository behind them, so they and their trials
   * stay private. Its name is its address on selfbench.dev, so one publisher holds each.
   */
  const buildEval = async (
    tenant: Org,
    repo: ConnectedRepo,
    body: BuildContext["body"],
    gathered: BuildContext["gathered"],
  ): Promise<Awaited<ReturnType<LineKind<ConnectedRepo>["build"]>>> => {
    if (body.publishTasks || body.publishTrials)
      return [400, { error: "An eval's tasks stay private: release its scores alone." }];
    const { report } = gathered;
    if (body.publishSummaries && !report)
      return [
        400,
        {
          error:
            "There are no model summaries to publish. Summarize models on the Results page first.",
        },
      ];
    const taken = (await options.releases.currentLinesFor(repo.fullName)).find(
      (other) => other.release.publisher.login.toLowerCase() !== tenant.login.toLowerCase(),
    );
    if (taken)
      return [
        409,
        {
          error: `${taken.release.publisher.login} already publishes an eval named ${repo.fullName} on selfbench.dev. Create the eval under another name to release it.`,
        },
      ];
    let built: BuiltRelease;
    try {
      built = buildRelease(gathered.inputs, body.settings, {
        repository: { id: repo.id, fullName: repo.fullName },
        publisher: { login: tenant.login, kind: tenant.kind },
        publishTasks: false,
        publishTrials: false,
        ...(body.publishSummaries && report ? { summaries: report } : {}),
      });
    } catch (error) {
      if (!(error instanceof ReleaseRefused)) throw error;
      return [400, { error: error.message }];
    }
    return {
      fullName: repo.fullName,
      hash: built.hash,
      payload: {
        ...built.payload,
        repository: {
          ...built.payload.repository,
          ...(tenant.avatarUrl ? { ownerAvatarUrl: tenant.avatarUrl } : {}),
        },
        publisher: {
          ...built.payload.publisher,
          ...(tenant.avatarUrl ? { avatarUrl: tenant.avatarUrl } : {}),
        },
      },
      detail: {
        ...built.detail,
        provenance: { selfbenchBuild: buildCommit, catalogVersion },
      },
    };
  };
  const kind: LineKind<ConnectedRepo> = {
    route,
    notFound: "Repository is not connected here",
    find: (tenant, fullName) => options.repos.find(tenant.id, fullName),
    lineOf: (_tenant, repo) => line(repo),
    async gather(tenant, repo, rows) {
      const [inputs, { report }] = await Promise.all([
        releaseInputs(options.db, options.artifacts, { repoId: repo.id, orgId: tenant.id }, rows),
        readModelSummaries(options.artifacts, { repoId: repo.id }),
      ]);
      return { inputs, ...(report ? { report } : {}) };
    },
    async build({ tenant, subject: repo, token, body, gathered }) {
      if (!isGitHubRepo(repo)) return buildEval(tenant, repo, body, gathered);
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
      const { report } = gathered;
      if (body.publishSummaries && !report)
        return [
          400,
          {
            error:
              "There are no model summaries to publish. Summarize models on the Results page first.",
          },
        ];
      let built: BuiltRelease;
      try {
        built = buildRelease(gathered.inputs, body.settings, {
          repository: { id: github.id, fullName: github.fullName },
          publisher: { login: tenant.login, kind: tenant.kind },
          publishTasks: body.publishTasks === true,
          publishTrials: body.publishTrials === true,
          ...(body.publishSummaries && report ? { summaries: report } : {}),
        });
      } catch (error) {
        if (!(error instanceof ReleaseRefused)) throw error;
        return [400, { error: error.message }];
      }
      const { private: isPrivate, archived, ...repository } = github;
      return {
        fullName: github.fullName,
        hash: built.hash,
        payload: {
          ...built.payload,
          repository: { ...repository, ...built.payload.repository },
          publisher: {
            ...built.payload.publisher,
            ...(tenant.avatarUrl ? { avatarUrl: tenant.avatarUrl } : {}),
          },
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
