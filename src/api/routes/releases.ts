import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import { buildCommit } from "../../contracts/config/build-metadata.js";
import type { Database } from "../../db/client.js";
import {
  currentOf,
  headOf,
  ReleaseConflict,
  type ReleaseLine,
  type ReleaseRow,
  type ReleaseStore,
} from "../../db/releases.js";
import type { ConnectedRepo, RepoStore } from "../../db/repos.js";
import type { Org, User, UserStore } from "../../db/users.js";
import { catalogVersion } from "../../evaluation/catalog.js";
import {
  type BuiltRelease,
  buildRelease,
  previewRelease,
  ReleaseRefused,
} from "../../public/release-build.js";
import {
  type GitHubRepository,
  lookupRepositoryById,
  releaseInputs,
} from "../../public/release-sources.js";
import { type ReleaseList, summaryOf, viewOf } from "../../public/release-views.js";
import { GitHubOAuthError } from "../../third_party/github/oauth.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";

const NAME = "([A-Za-z0-9_.-]+)";
const route = new RegExp(
  `^/api/orgs/${NAME}/repos/${NAME}/${NAME}/releases(?:/(preview|[a-f0-9-]{36}))?(?:/(withdraw))?$`,
);

const releaseRequest = z
  .object({
    settings: z.array(z.string().min(1).max(4096)).min(1).max(500),
    /** The line's head as the releaser saw it; null for a first release. */
    head: z.uuid().nullable(),
    /** The fingerprint of the preview the releaser confirmed. */
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type ReleaseRequest = z.infer<typeof releaseRequest>;

export interface ReleaseRoutesOptions {
  readonly db: Database;
  readonly artifacts: ArtifactStore;
  readonly users: UserStore;
  readonly repos: RepoStore;
  readonly releases: ReleaseStore;
  readonly publicUrl: string;
  readonly githubApiUrl: string;
  /** Origin of the results site, for links to released pages. */
  readonly resultsSiteUrl: string;
  readonly fetchImpl?: typeof fetch;
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

  /** Reads what the rule needs now and builds the preview from it. */
  const gather = async (scope: Scope, rows: readonly ReleaseRow[]) => {
    const inputs = await releaseInputs(
      options.db,
      options.artifacts,
      { repoId: scope.repo.id, orgId: scope.tenant.id },
      rows,
    );
    return { inputs, view: viewOf(rows, previewRelease(inputs)) };
  };

  /** Writes a release for the settings the request names, or answers why not. */
  const release = async (
    scope: Scope,
    rows: readonly ReleaseRow[],
    body: ReleaseRequest,
    response: ServerResponse,
  ) => {
    const { inputs, view: fresh } = await gather(scope, rows);
    const head = headOf(rows);
    // Someone released, or withdrew and released, since this person looked.
    if (body.head !== (head?.id ?? null)) {
      sendJson(response, 409, {
        error: head
          ? `${head.releasedByLogin} released at ${head.releasedAt}. Review the refreshed preview.`
          : "The release you saw is gone. Review the refreshed preview.",
        ...fresh,
      });
      return;
    }
    // Results, tasks, or the current release changed since the preview was taken.
    if (body.fingerprint !== fresh.preview.fingerprint) {
      sendJson(response, 409, {
        error:
          "Results, tasks, or the current release changed since you opened this. Review the refreshed preview.",
        ...fresh,
      });
      return;
    }
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
      return;
    }
    // Checked live: the repository may have turned private since it was connected.
    if (!github || github.private) {
      sendJson(response, 400, { error: "Only public repositories can be released." });
      return;
    }
    let built: BuiltRelease;
    try {
      built = buildRelease(inputs, body.settings, {
        repository: { id: github.id, fullName: github.fullName },
        publisher: { login: scope.tenant.login, kind: scope.tenant.kind },
      });
    } catch (error) {
      if (!(error instanceof ReleaseRefused)) throw error;
      sendJson(response, 400, { error: error.message });
      return;
    }
    // Unchanged results write no row: a double click or a retry. The line is read again after
    // the GitHub lookup, so a withdrawal meanwhile is not mistaken for "still public".
    const now = await releases.list(scope.line);
    const current = currentOf(now);
    if (current && current.hash === built.hash && headOf(now)?.id === head?.id) {
      sendJson(response, 200, { unchanged: true, release: summaryOf(current, now) });
      return;
    }
    const { private: isPrivate, archived, ...repository } = github;
    try {
      const row = await releases.insert({
        line: scope.line,
        fullName: github.fullName,
        publisherLogin: scope.tenant.login,
        ...(head ? { predecessorId: head.id } : {}),
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
      });
      const after = await releases.list(scope.line);
      sendJson(response, 201, { release: summaryOf(row, after) });
    } catch (error) {
      if (!(error instanceof ReleaseConflict)) throw error;
      const after = await releases.list(scope.line);
      sendJson(response, 409, {
        error: "Someone else released first. Review the refreshed preview.",
        ...(await gather(scope, after)).view,
      });
    }
  };

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
          releases: rows.map((row) => summaryOf(row, rows)),
          resultsSiteUrl: options.resultsSiteUrl,
        };
        sendJson(response, 200, list);
      } else if (request.method === "GET" && section === "preview") {
        sendJson(response, 200, (await gather(scope, rows)).view);
      } else if (mutation && section && section !== "preview" && action === "withdraw") {
        const withdrawn = z.uuid().safeParse(section).success
          ? await releases.withdraw(scope.line, section, user.login)
          : undefined;
        if (!withdrawn)
          sendJson(response, 404, { error: "Release not found or already withdrawn" });
        else
          sendJson(response, 200, {
            release: summaryOf(withdrawn, await releases.list(scope.line)),
          });
      } else if (mutation && !section) {
        const body = releaseRequest.parse(
          JSON.parse((await readBody(request, 1024 * 1024)).toString()),
        );
        await release(scope, rows, body, response);
      } else sendJson(response, 405, { error: "Method not allowed" });
      return true;
    },
  };
}
export type ReleaseRoutes = ReturnType<typeof createReleaseRoutes>;
