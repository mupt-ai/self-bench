import type { ArtifactStore } from "../../artifacts/index.js";
import { buildCommit } from "../../contracts/config/build-metadata.js";
import type { Database } from "../../db/client.js";
import type { EvalLine, ReleaseLine, ReleaseStore } from "../../db/releases.js";
import {
  type ConnectedRepo,
  type GitHubRepo,
  isGitHubRepo,
  type RepoStore,
} from "../../db/repos.js";
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
import type { ReleaseRepository } from "../../public/release-types.js";
import { GitHubOAuthError } from "../../third_party/github/oauth.js";
import {
  createLineRoutes,
  type LineKind,
  type ReleaseRequest,
  type Reply,
} from "./release-line.js";

/**
 * What is being released, checked live: the repository's or eval's card metadata, and what the
 * release's private detail records about it.
 */
interface Subject {
  repository: ReleaseRepository;
  detail: Record<string, unknown>;
}

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
  /** A connected repository, checked live on GitHub: public, and its card metadata. */
  const github = async (repo: GitHubRepo, token: string): Promise<Subject | Reply> => {
    let found: GitHubRepository | undefined;
    try {
      found = await lookupRepositoryById(options.githubApiUrl, token, repo.githubId, fetchImpl);
    } catch (error) {
      if (!(error instanceof GitHubOAuthError)) throw error;
      return [
        503,
        { error: "GitHub could not confirm that the repository is public. Try again in a moment." },
      ];
    }
    // Checked live: the repository may have turned private since it was connected.
    if (!found || found.private)
      return [400, { error: "Only public repositories can be released." }];
    const { private: isPrivate, archived, ...repository } = found;
    return { repository, detail: { repositoryFlags: { private: isPrivate, archived } } };
  };
  /**
   * An eval, under its `evals/<slug>` name, marked with its publisher's avatar. Its tasks are
   * scenarios with no public repository behind them, so they and their trials stay private. Its
   * name is its address on selfbench.dev, so one publisher holds each.
   */
  const evalSubject = async (
    tenant: Org,
    repo: ConnectedRepo,
    body: ReleaseRequest,
  ): Promise<Subject | Reply> => {
    if (body.publishTasks || body.publishTrials)
      return [400, { error: "An eval's tasks stay private: release its scores alone." }];
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
    const avatar = tenant.avatarUrl ? { ownerAvatarUrl: tenant.avatarUrl } : {};
    return { repository: { id: repo.id, fullName: repo.fullName, ...avatar }, detail: {} };
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
      const subject = isGitHubRepo(repo)
        ? await github(repo, token)
        : await evalSubject(tenant, repo, body);
      if (!("repository" in subject)) return subject;
      const { report } = gathered;
      if (body.publishSummaries && !report)
        return [
          400,
          {
            error:
              "There are no model summaries to publish. Summarize models on the Results page first.",
          },
        ];
      const { repository } = subject;
      let built: BuiltRelease;
      try {
        built = buildRelease(gathered.inputs, body.settings, {
          repository: { id: repository.id, fullName: repository.fullName },
          publisher: { login: tenant.login, kind: tenant.kind },
          publishTasks: body.publishTasks === true,
          publishTrials: body.publishTrials === true,
          ...(body.publishSummaries && report ? { summaries: report } : {}),
        });
      } catch (error) {
        if (!(error instanceof ReleaseRefused)) throw error;
        return [400, { error: error.message }];
      }
      return {
        fullName: repository.fullName,
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
          ...subject.detail,
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
