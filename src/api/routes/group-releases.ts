import type { ArtifactStore } from "../../artifacts/index.js";
import type { Database } from "../../db/client.js";
import type { GroupStore, RepositoryGroup } from "../../db/groups.js";
import type { ReleaseStore } from "../../db/releases.js";
import { type GitHubRepo, isGitHubRepo, type RepoStore } from "../../db/repos.js";
import type { UserStore } from "../../db/users.js";
import { canonicalJson, sha256 } from "../../lib/hash.js";
import { track } from "../../lib/telemetry/posthog.js";
import { buildRelease, ReleaseRefused } from "../../public/release-build.js";
import { type GroupMember, groupHref, membersOf } from "../../public/release-groups.js";
import type { ReleaseTask } from "../../public/release-rule.js";
import { lineInputs, lookupRepositoryById, releaseTasks } from "../../public/release-sources.js";
import { createLineRoutes, type LineKind, type Reply } from "./release-line.js";

/** `[org, slug, section?, action?]`. */
const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/groups\/([a-z0-9-]{1,60})\/releases(?:\/(preview|[a-f0-9-]{36}))?(?:\/(withdraw))?$/;

export interface GroupReleaseRoutesOptions {
  readonly db: Database;
  readonly artifacts: ArtifactStore;
  readonly users: UserStore;
  readonly repos: RepoStore;
  readonly groups: GroupStore;
  readonly releases: ReleaseStore;
  readonly publicUrl: string;
  readonly githubApiUrl: string;
  readonly resultsSiteUrl: string | null;
  readonly fetchImpl?: typeof fetch;
  /** Told the paths whose public pages a release or withdrawal changed. */
  readonly onPublicChange?: (paths: string[]) => void;
}

/** A group with its connected members and which member (GitHub id) each task belongs to. */
interface Subject {
  group: RepositoryGroup;
  members: GitHubRepo[];
  owner: Map<string, number>;
  tasks: ReleaseTask[];
}

/**
 * A repository group's releases: a repository's Releases tab (release-line.ts) over the group's
 * runs and its members' own, on every member's tasks. Only its scores are published, never its
 * tasks or transcripts, each setting's over the group and on each member, and only while every
 * member is connected and public.
 */
export function createGroupReleaseRoutes(options: GroupReleaseRoutesOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  /** Each member as GitHub reports it now, or why the group cannot be released. */
  const publicMembers = async (
    members: readonly GitHubRepo[],
    token: string,
  ): Promise<{ repositories: GroupMember["repository"][] } | { reply: Reply }> => {
    const repositories: GroupMember["repository"][] = [];
    for (const repo of members) {
      const github = await lookupRepositoryById(
        options.githubApiUrl,
        token,
        repo.githubId,
        fetchImpl,
      ).catch(() => undefined);
      if (!github) {
        const error = `GitHub could not confirm that ${repo.fullName} is public. Try again in a moment.`;
        return { reply: [503, { error }] };
      }
      if (github.private) {
        const error = `${repo.fullName} is private. Only groups of public repositories can be released.`;
        return { reply: [400, { error }] };
      }
      const { id, fullName, description, stars, ownerAvatarUrl } = github;
      repositories.push({
        id,
        fullName,
        ...(description ? { description } : {}),
        ...(stars !== undefined ? { stars } : {}),
        ...(ownerAvatarUrl ? { ownerAvatarUrl } : {}),
      });
    }
    return { repositories };
  };

  const kind: LineKind<Subject> = {
    route,
    notFound: "Group not found",
    async find(tenant, slug) {
      const group = await options.groups.find(tenant.id, slug);
      if (!group) return undefined;
      const connected = (await options.repos.list(tenant.id)).filter(isGitHubRepo);
      const members = group.repositoryIds.flatMap(
        (id) => connected.find((repo) => repo.githubId === id) ?? [],
      );
      const owner = new Map<string, number>();
      const tasks: ReleaseTask[] = [];
      for (const repo of members)
        for (const task of await releaseTasks(options.db, repo.id)) {
          owner.set(task.key, repo.githubId);
          tasks.push(task);
        }
      return { group, members, owner, tasks };
    },
    lineOf: (tenant, { group }) => ({ orgId: tenant.id, groupId: group.id }),
    async gather(tenant, { group, members, tasks }, rows) {
      const inputs = await lineInputs(
        options.db,
        options.artifacts,
        {
          // The group's own runs and its members' count alike, as its Results page shows them.
          scopes: [{ groupId: group.id }, ...members.map((repo) => ({ repoId: repo.id }))],
          orgId: tenant.id,
          tasks: Promise.resolve(tasks),
        },
        rows,
      );
      return { inputs };
    },
    async build({ tenant, subject, token, body, gathered }) {
      const { group, members, owner } = subject;
      if (body.publishTasks || body.publishTrials || body.publishSummaries)
        return [400, { error: "A group publishes its scores only." }];
      // The page names every member, so each must still be here to be scored and checked.
      if (members.length < group.repositoryIds.length)
        return [
          400,
          {
            error:
              "A repository in this group is no longer connected. Reconnect or remove it in Settings first.",
          },
        ];
      const live = await publicMembers(members, token);
      if ("reply" in live) return live.reply;
      const checked = live.repositories;
      let built: ReturnType<typeof buildRelease>;
      try {
        built = buildRelease(gathered.inputs, body.settings, {
          repository: { id: group.id, fullName: group.name },
          publisher: { login: tenant.login, kind: tenant.kind },
        });
      } catch (error) {
        if (!(error instanceof ReleaseRefused)) throw error;
        return [400, { error: error.message }];
      }
      const { settings, frontier, tasks } = built.payload;
      const keyed = settings.map((setting, index) => ({
        id: setting.id,
        key: built.detail.settings[index] ?? "",
      }));
      const results = (built.detail.results ?? {}) as Parameters<typeof membersOf>[3];
      return {
        fullName: group.slug,
        // What the page shows besides the scores: the group's own fields and its members in
        // order; stars and avatars drift without changing the release.
        hash: sha256(
          canonicalJson({
            scores: built.hash,
            group: [group.slug, group.name, group.description],
            members: checked.map(({ id, fullName }) => [id, fullName]),
          }),
        ),
        payload: {
          publisher: {
            login: tenant.login,
            kind: tenant.kind,
            ...(tenant.avatarUrl ? { avatarUrl: tenant.avatarUrl } : {}),
          },
          slug: group.slug,
          name: group.name,
          ...(group.description ? { description: group.description } : {}),
          members: membersOf(checked, owner, keyed, results),
          tasks,
          settings,
          frontier,
        },
        detail: built.detail,
      };
    },
    changed(tenant, row, user, released) {
      options.onPublicChange?.(["/", groupHref(row.publisherLogin, row.fullName)]);
      if (released) track(user, "group release published", { group: row.fullName }, tenant);
    },
  };
  return createLineRoutes(options, kind);
}
export type GroupReleaseRoutes = ReturnType<typeof createGroupReleaseRoutes>;
