import type { ArtifactStore } from "../../artifacts/index.js";
import type { Database } from "../../db/client.js";
import type { GroupStore, RepositoryGroup } from "../../db/groups.js";
import type { ReleaseStore } from "../../db/releases.js";
import { type GitHubRepo, isGitHubRepo, type RepoStore } from "../../db/repos.js";
import type { UserStore } from "../../db/users.js";
import { readModelSummaries } from "../../evaluation/model-summary.js";
import { canonicalJson, sha256 } from "../../lib/hash.js";
import { track } from "../../lib/telemetry/posthog.js";
import { type GroupMember, groupHref, membersOf } from "../../public/release-groups.js";
import type { ReleaseTask } from "../../public/release-rule.js";
import { lineInputs, lookupRepositoryById, releaseTasks } from "../../public/release-sources.js";
import {
  buildRequested,
  createLineRoutes,
  isReply,
  type LineKind,
  publisherOf,
  type Reply,
} from "./release-line.js";

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
 * runs and its members' own, on every member's tasks: each setting's scores over the group and on
 * each member, and, as a repository's, its tasks, their trials, and its model summaries when the
 * releaser publishes them. Only while every member is connected and public.
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
      // Each task names its member, so its published page links that repository's pull request.
      for (const repo of members)
        for (const task of await releaseTasks(options.db, repo.id)) {
          owner.set(task.key, repo.githubId);
          tasks.push({ ...task, repository: repo.fullName });
        }
      return { group, members, owner, tasks };
    },
    lineOf: (tenant, { group }) => ({ orgId: tenant.id, groupId: group.id }),
    async gather(tenant, { group, members, tasks }, rows) {
      const [inputs, { report }] = await Promise.all([
        lineInputs(
          options.db,
          options.artifacts,
          {
            // The group's own runs and its members' count alike, as its Results page shows them.
            scopes: [{ groupId: group.id }, ...members.map((repo) => ({ repoId: repo.id }))],
            orgId: tenant.id,
            tasks: Promise.resolve(tasks),
          },
          rows,
        ),
        readModelSummaries(options.artifacts, { groupId: group.id }),
      ]);
      return { inputs, ...(report ? { report } : {}) };
    },
    async build({ tenant, subject, token, body, gathered }) {
      const { group, members, owner } = subject;
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
      const built = buildRequested(gathered, body, {
        repository: { id: group.id, fullName: group.name },
        publisher: { login: tenant.login, kind: tenant.kind },
      });
      if (isReply(built)) return built;
      const { settings, frontier, tasks, tasksPublished, trialsPublished, modelSummaries } =
        built.payload;
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
            group: [group.slug, group.name, group.description, group.logo],
            members: checked.map(({ id, fullName }) => [id, fullName]),
          }),
        ),
        payload: {
          publisher: publisherOf(tenant),
          slug: group.slug,
          name: group.name,
          ...(group.description ? { description: group.description } : {}),
          ...(group.logo ? { logo: group.logo } : {}),
          members: membersOf(checked, owner, keyed, results),
          tasks,
          settings,
          frontier,
          ...(tasksPublished ? { tasksPublished } : {}),
          ...(trialsPublished ? { trialsPublished } : {}),
          ...(modelSummaries ? { modelSummaries } : {}),
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
