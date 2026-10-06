import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import { buildCommit } from "../../contracts/config/build-metadata.js";
import type { Database } from "../../db/client.js";
import type { ReleaseLine, ReleaseRow, ReleaseStore } from "../../db/releases.js";
import type { ConnectedRepo, RepoStore } from "../../db/repos.js";
import type { Org, User, UserStore } from "../../db/users.js";
import { catalogVersion } from "../../evaluation/catalog.js";
import { track } from "../../lib/telemetry/posthog.js";
import { buildRelease, previewRelease, type ReleaseInputs } from "../../public/release-build.js";
import {
  type GitHubRepository,
  lookupRepositoryById,
  releaseInputs,
} from "../../public/release-sources.js";
import { type ReleaseList, summaryOf, viewOf } from "../../public/release-views.js";
import { GitHubOAuthError } from "../../third_party/github/oauth.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import { type Line, publish, type ReleaseRequest, releaseRequest } from "./release-line.js";

const NAME = "([A-Za-z0-9_.-]+)";
const route = new RegExp(
  `^/api/orgs/${NAME}/repos/${NAME}/${NAME}/releases(?:/(preview|[a-f0-9-]{36}))?(?:/(withdraw))?$`,
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

/** A signed-in member's request, scoped to one connected repository. */
interface Scope {
  readonly user: User;
  readonly tenant: Org;
  readonly repo: ConnectedRepo;
  readonly line: ReleaseLine;
}

export function createReleaseRoutes(options: ReleaseRoutesOptions) {
  const { users, repos, releases } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  /** Where a row's line shows on selfbench.dev: the repository's page for its publisher. */
  const pathOf = (row: ReleaseRow) => `/${row.fullName}/${row.publisherLogin}`;

  /** The repository's line, as `publish` runs it. */
  const lineOf = (
    scope: Scope,
  ): Line<ReleaseRow, ReleaseInputs, GitHubRepository, ReleaseRequest> => ({
    list: () => releases.list(scope.line),
    async gather(rows) {
      const inputs = await releaseInputs(
        options.db,
        options.artifacts,
        { repoId: scope.repo.id, orgId: scope.tenant.id },
        rows,
      );
      return { inputs, view: viewOf(rows, previewRelease(inputs), pathOf) };
    },
    pathOf,
    async check(response) {
      const token = await users.gitHubToken(scope.user.githubId);
      if (!token) throw new GitHubOAuthError("no GitHub token stored for this user", 401);
      let github: GitHubRepository | undefined;
      try {
        github = await lookupRepositoryById(
          options.githubApiUrl,
          token,
          scope.repo.githubId,
          fetchImpl,
        );
      } catch (error) {
        if (!(error instanceof GitHubOAuthError)) throw error;
        sendJson(response, 503, {
          error: "GitHub could not confirm that the repository is public. Try again in a moment.",
        });
        return undefined;
      }
      // Checked live: the repository may have turned private since it was connected.
      if (!github || github.private) {
        sendJson(response, 400, { error: "Only public repositories can be released." });
        return undefined;
      }
      return github;
    },
    build(inputs, github, request) {
      const built = buildRelease(inputs, request.settings, {
        repository: { id: github.id, fullName: github.fullName },
        publisher: { login: scope.tenant.login, kind: scope.tenant.kind },
        publishTasks: request.publishTasks === true,
      });
      const { private: isPrivate, archived, ...repository } = github;
      return {
        hash: built.hash,
        save: (head) =>
          releases.insert({
            line: scope.line,
            fullName: github.fullName,
            publisherLogin: scope.tenant.login,
            ...(head ? { predecessorId: head } : {}),
            releasedBy: { id: scope.user.id, login: scope.user.login },
            hash: built.hash,
            payload: {
              ...built.payload,
              repository: { ...repository, ...built.payload.repository },
              publisher: {
                ...built.payload.publisher,
                ...(scope.tenant.avatarUrl ? { avatarUrl: scope.tenant.avatarUrl } : {}),
              },
            },
            detail: {
              ...built.detail,
              provenance: { selfbenchBuild: buildCommit, catalogVersion },
              repositoryFlags: { private: isPrivate, archived },
            },
          }),
      };
    },
    published(row) {
      options.onPublicChange?.({ fullName: row.fullName, publisher: row.publisherLogin });
      track(scope.user, "release published", { repo: row.fullName }, scope.tenant);
    },
  });

  return {
    /** Answers /api/orgs/:org/repos/:owner/:name/releases; true when the response was sent. */
    async handle(
      request: IncomingMessage,
      url: URL,
      response: ServerResponse,
      user: User,
    ): Promise<boolean> {
      const match = route.exec(url.pathname);
      if (!match?.[1] || !match[2] || !match[3]) return false;
      response.setHeader("cache-control", "no-store");
      const [section, action] = [match[4], match[5]];
      const tenant = await tenantFor(users, user, match[1]);
      const repo = tenant ? await repos.find(tenant.id, `${match[2]}/${match[3]}`) : undefined;
      if (!tenant || !repo) {
        sendJson(response, 404, { error: "Repository is not connected here" });
        return true;
      }
      const mutation = request.method === "POST";
      if (mutation && !trustedMutation(request, options.publicUrl, user)) {
        sendJson(response, 403, { error: "Same-origin JSON request required" });
        return true;
      }
      const scope: Scope = {
        user,
        tenant,
        repo,
        line: { orgId: tenant.id, githubRepoId: repo.githubId },
      };
      const rows = await releases.list(scope.line);
      if (request.method === "GET" && !section) {
        const list: ReleaseList = {
          releases: rows.map((row) => summaryOf(row, rows, pathOf(row))),
          resultsSiteUrl: options.resultsSiteUrl,
        };
        sendJson(response, 200, list);
      } else if (request.method === "GET" && section === "preview") {
        sendJson(response, 200, (await lineOf(scope).gather(rows)).view);
      } else if (mutation && section && section !== "preview" && action === "withdraw") {
        const withdrawn = z.uuid().safeParse(section).success
          ? await releases.withdraw(scope.line, section, user.login)
          : undefined;
        if (!withdrawn) {
          sendJson(response, 404, { error: "Release not found or already withdrawn" });
        } else {
          options.onPublicChange?.({
            fullName: withdrawn.fullName,
            publisher: withdrawn.publisherLogin,
          });
          sendJson(response, 200, {
            release: summaryOf(withdrawn, await releases.list(scope.line), pathOf(withdrawn)),
          });
        }
      } else if (mutation && !section) {
        const body = releaseRequest.parse(
          JSON.parse((await readBody(request, 1024 * 1024)).toString()),
        );
        await publish(lineOf(scope), rows, body, response);
      } else sendJson(response, 405, { error: "Method not allowed" });
      return true;
    },
  };
}
export type ReleaseRoutes = ReturnType<typeof createReleaseRoutes>;
