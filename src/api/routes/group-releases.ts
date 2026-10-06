import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import { buildCommit } from "../../contracts/config/build-metadata.js";
import type { Database } from "../../db/client.js";
import {
  type GroupReleaseLine,
  type GroupReleaseRow,
  type GroupReleaseStore,
  SlugTaken,
} from "../../db/group-releases.js";
import { headOf } from "../../db/releases.js";
import type { RepoGroup, RepoGroupStore } from "../../db/repo-groups.js";
import type { ConnectedRepo, RepoStore } from "../../db/repos.js";
import type { Org, User, UserStore } from "../../db/users.js";
import { catalogVersion } from "../../evaluation/catalog.js";
import { track } from "../../lib/telemetry/posthog.js";
import { buildGroupRelease } from "../../public/group-release-build.js";
import { GROUP_SLUG, suggestedSlug } from "../../public/paths.js";
import {
  previewRelease,
  type ReleaseInputs,
  ReleaseRefused,
  scoreRelease,
} from "../../public/release-build.js";
import {
  type GitHubRepository,
  groupReleaseInputs,
  publicRepositories,
} from "../../public/release-sources.js";
import {
  type GroupReleaseView,
  type ReleaseList,
  summaryOf,
  viewOf,
} from "../../public/release-views.js";
import { GitHubOAuthError } from "../../third_party/github/oauth.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import { type Line, publish, releaseRequest } from "./release-line.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/groups\/([a-f0-9-]{36})\/releases(?:\/(preview|[a-f0-9-]{36}))?(?:\/(withdraw))?$/;

/** A repository release's request, plus the address a group's first release claims. */
const groupReleaseRequest = releaseRequest
  .extend({ slug: z.string().regex(GROUP_SLUG).optional() })
  .strict();
type GroupReleaseRequest = z.infer<typeof groupReleaseRequest>;

export interface GroupReleaseRoutesOptions {
  readonly db: Database;
  readonly artifacts: ArtifactStore;
  readonly users: UserStore;
  readonly repos: RepoStore;
  readonly groups: RepoGroupStore;
  readonly releases: GroupReleaseStore;
  readonly publicUrl: string;
  readonly githubApiUrl: string;
  readonly resultsSiteUrl: string | null;
  readonly fetchImpl?: typeof fetch;
  /** Told when what the public sees changes, so it is read afresh and search engines told. */
  readonly onPublicChange?: (change: { slug: string }) => void;
}

interface Scope {
  readonly user: User;
  readonly tenant: Org;
  readonly group: RepoGroup;
  /** The group's members as connected here, with the GitHub ids their tasks are keyed by. */
  readonly members: readonly ConnectedRepo[];
  readonly line: GroupReleaseLine;
}

/** The members as GitHub reports them now, and the address the release goes to. */
interface Checked {
  readonly slug: string;
  readonly members: readonly GitHubRepository[];
}

type Gathered = { inputs: ReleaseInputs; memberOf: Map<string, number> };

const pathOf = (row: GroupReleaseRow) => `/groups/${row.slug}`;

export function createGroupReleaseRoutes(options: GroupReleaseRoutesOptions) {
  const { users, releases } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  const lineOf = (scope: Scope): Line<GroupReleaseRow, Gathered, Checked, GroupReleaseRequest> => ({
    list: () => releases.list(scope.line),
    async gather(rows) {
      const gathered = await groupReleaseInputs(
        options.db,
        options.artifacts,
        {
          orgId: scope.tenant.id,
          members: scope.members.map((repo) => ({ repoId: repo.id, key: repo.githubId })),
        },
        rows,
      );
      const names = new Map(scope.members.map((repo) => [repo.githubId, repo.fullName]));
      const preview = previewRelease(gathered.inputs);
      // Each task names its member, so the dialog can show what each repository contributes.
      const tasks = preview.tasks.map((task) => {
        const member = gathered.memberOf.get(task.key);
        const repository = member === undefined ? undefined : names.get(member);
        return repository ? { ...task, repository } : task;
      });
      return {
        inputs: gathered,
        view: {
          ...viewOf(rows, { ...preview, tasks }, pathOf),
          slug: headOf(rows)?.slug ?? null,
          suggestedSlug: suggestedSlug(scope.group.name),
        } satisfies GroupReleaseView,
      };
    },
    pathOf,
    async check(response, request, { rows, inputs }) {
      // A line keeps the address its first release claimed; a first release claims one free.
      const head = headOf(rows);
      const slug = head?.slug ?? request.slug;
      if (!slug) {
        sendJson(response, 400, { error: "Choose an address for the group's page." });
        return undefined;
      }
      if (!head && (await releases.slugTaken(slug, scope.line))) {
        sendJson(response, 400, { error: "This address is taken. Choose another." });
        return undefined;
      }
      // Only members with a task in the release are published, so only they must be public.
      let released: ReadonlySet<number>;
      try {
        const { tasks } = scoreRelease(inputs.inputs, request.settings);
        released = new Set(tasks.flatMap((task) => inputs.memberOf.get(task) ?? []));
      } catch (error) {
        if (!(error instanceof ReleaseRefused)) throw error;
        sendJson(response, 400, { error: error.message });
        return undefined;
      }
      const members = scope.members.filter((repo) => released.has(repo.githubId));
      const token = await users.gitHubToken(scope.user.githubId);
      if (!token) throw new GitHubOAuthError("no GitHub token stored for this user", 401);
      // Checked live: any may have turned private since it was connected.
      const found = await publicRepositories(options.githubApiUrl, token, members, fetchImpl);
      if ("error" in found) {
        sendJson(response, found.status, { error: found.error });
        return undefined;
      }
      return { slug, members: found.repositories };
    },
    build({ inputs, memberOf }, checked, request) {
      const built = buildGroupRelease(inputs, request.settings, {
        group: { slug: checked.slug, name: scope.group.name },
        members: checked.members,
        memberOf,
        publisher: { login: scope.tenant.login, kind: scope.tenant.kind },
        publishTasks: request.publishTasks === true,
      });
      const cards = new Map(
        checked.members.map(({ private: _private, archived: _archived, ...card }) => [
          card.id,
          card,
        ]),
      );
      return {
        hash: built.hash,
        async save(head) {
          try {
            return await releases.insert({
              line: scope.line,
              slug: checked.slug,
              name: scope.group.name,
              publisherLogin: scope.tenant.login,
              ...(head ? { predecessorId: head } : {}),
              releasedBy: { id: scope.user.id, login: scope.user.login },
              hash: built.hash,
              payload: {
                ...built.payload,
                group: {
                  ...built.payload.group,
                  members: built.payload.group.members.map((member) => ({
                    ...cards.get(member.id),
                    ...member,
                  })),
                },
                publisher: {
                  ...built.payload.publisher,
                  ...(scope.tenant.avatarUrl ? { avatarUrl: scope.tenant.avatarUrl } : {}),
                },
              },
              detail: {
                ...built.detail,
                provenance: { selfbenchBuild: buildCommit, catalogVersion },
              },
            });
          } catch (error) {
            if (error instanceof SlugTaken)
              throw new ReleaseRefused("This address is taken. Choose another.");
            throw error;
          }
        },
      };
    },
    published(row) {
      options.onPublicChange?.({ slug: row.slug });
      track(scope.user, "group release published", { group: row.slug }, scope.tenant);
    },
  });

  return {
    /** Answers /api/orgs/:org/groups/:id/releases; true when the response was sent. */
    async handle(
      request: IncomingMessage,
      url: URL,
      response: ServerResponse,
      user: User,
    ): Promise<boolean> {
      const match = route.exec(url.pathname);
      if (!match?.[1] || !match[2]) return false;
      response.setHeader("cache-control", "no-store");
      const [section, action] = [match[3], match[4]];
      const tenant = await tenantFor(users, user, match[1]);
      if (!tenant) {
        sendJson(response, 404, { error: "Group not found" });
        return true;
      }
      const mutation = request.method === "POST";
      if (mutation && !trustedMutation(request, options.publicUrl, user)) {
        sendJson(response, 403, { error: "Same-origin JSON request required" });
        return true;
      }
      const line = { orgId: tenant.id, groupId: match[2] };
      // A release outlives its group, so it can always be withdrawn.
      if (mutation && section && section !== "preview" && action === "withdraw") {
        const withdrawn = z.uuid().safeParse(section).success
          ? await releases.withdraw(line, section, user.login)
          : undefined;
        if (!withdrawn) {
          sendJson(response, 404, { error: "Release not found or already withdrawn" });
        } else {
          options.onPublicChange?.({ slug: withdrawn.slug });
          sendJson(response, 200, {
            release: summaryOf(withdrawn, await releases.list(line), pathOf(withdrawn)),
          });
        }
        return true;
      }
      const group = await options.groups.find(tenant.id, match[2]);
      if (!group) {
        sendJson(response, 404, { error: "Group not found" });
        return true;
      }
      const connected = new Map(
        (await options.repos.list(tenant.id)).map((repo) => [repo.id, repo]),
      );
      const scope: Scope = {
        user,
        tenant,
        group,
        members: group.repos.flatMap((repo) => connected.get(repo.id) ?? []),
        line,
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
      } else if (mutation && !section) {
        if (scope.members.length === 0) {
          sendJson(response, 400, { error: "Add a repository to this group first." });
          return true;
        }
        const body = groupReleaseRequest.parse(
          JSON.parse((await readBody(request, 1024 * 1024)).toString()),
        );
        await publish(lineOf(scope), rows, body, response);
      } else sendJson(response, 405, { error: "Method not allowed" });
      return true;
    },
  };
}
export type GroupReleaseRoutes = ReturnType<typeof createGroupReleaseRoutes>;
