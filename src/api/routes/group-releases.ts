import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { Database } from "../../db/client.js";
import type { GroupReleaseRow, GroupReleaseStore } from "../../db/group-releases.js";
import type { GroupStore, RepositoryGroup } from "../../db/groups.js";
import { currentOf, headOf, ReleaseConflict } from "../../db/releases.js";
import type { RepoStore } from "../../db/repos.js";
import type { User, UserStore } from "../../db/users.js";
import { canonicalJson, sha256 } from "../../lib/hash.js";
import { track } from "../../lib/telemetry/posthog.js";
import { buildRelease, previewRelease, ReleaseRefused } from "../../public/release-build.js";
import { type GroupMember, groupHref, membersOf } from "../../public/release-groups.js";
import type { ReleaseTask } from "../../public/release-rule.js";
import { lineInputs, lookupRepositoryById, releaseTasks } from "../../public/release-sources.js";
import type { ReleaseList, ReleaseSummary, ReleaseView } from "../../public/release-views.js";
import { GitHubOAuthError } from "../../third_party/github/oauth.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/groups\/([a-z0-9-]{1,60})\/releases(?:\/(preview|[a-f0-9-]{36}))?(?:\/(withdraw))?$/;

const releaseRequest = z
  .object({
    settings: z.array(z.string().min(1).max(4096)).min(1).max(500),
    head: z.uuid().nullable(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    // A group publishes its scores only; the dialog sends these off.
    publishTasks: z.literal(false).optional(),
    publishTrials: z.literal(false).optional(),
    publishSummaries: z.literal(false).optional(),
  })
  .strict();

export interface GroupReleaseRoutesOptions {
  readonly db: Database;
  readonly artifacts: ArtifactStore;
  readonly users: UserStore;
  readonly repos: RepoStore;
  readonly groups: GroupStore;
  readonly releases: GroupReleaseStore;
  readonly publicUrl: string;
  readonly githubApiUrl: string;
  readonly resultsSiteUrl: string | null;
  readonly fetchImpl?: typeof fetch;
  /** Told the paths whose public pages a release or withdrawal changed. */
  readonly onPublicChange?: (paths: string[]) => void;
}

/** A group release as the Releases tab lists it, in the shape a repository's takes. */
function summaryOf(row: GroupReleaseRow, rows: readonly GroupReleaseRow[]): ReleaseSummary {
  return {
    id: row.id,
    releasedAt: row.releasedAt,
    releasedBy: row.releasedByLogin,
    ...(row.withdrawnAt ? { withdrawnAt: row.withdrawnAt } : {}),
    ...(row.withdrawnByLogin ? { withdrawnBy: row.withdrawnByLogin } : {}),
    fullName: row.slug,
    publisher: row.publisherLogin,
    tasks: row.payload.tasks,
    settings: row.payload.settings.length,
    tasksPublished: false,
    trialsPublished: false,
    summariesPublished: false,
    current: currentOf(rows)?.id === row.id,
    head: headOf(rows)?.id === row.id,
  };
}

/**
 * A repository group's releases: the same Releases tab, preview, release and withdrawal a
 * repository has, over the group's own runs and every member's tasks. Only its scores are
 * published, never its tasks or transcripts, and only while every member is public.
 */
export function createGroupReleaseRoutes(options: GroupReleaseRoutesOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  /** The group's connected members, and which member each of their tasks belongs to. */
  const membersAndTasks = async (orgId: number, group: RepositoryGroup) => {
    const connected = await options.repos.list(orgId);
    const members = group.repositoryIds.flatMap((id) => {
      const repo = connected.find((each) => each.githubId === id);
      return repo ? [repo] : [];
    });
    const owner = new Map<string, number>();
    const tasks: ReleaseTask[] = [];
    for (const repo of members)
      for (const task of await releaseTasks(options.db, repo.id)) {
        owner.set(task.key, repo.githubId);
        tasks.push(task);
      }
    return { members, owner, tasks };
  };

  const gather = async (orgId: number, group: RepositoryGroup, rows: GroupReleaseRow[]) => {
    const { members, owner, tasks } = await membersAndTasks(orgId, group);
    const inputs = await lineInputs(
      options.db,
      options.artifacts,
      {
        // The group's own runs and its members' count alike, as its Results page shows them.
        scopes: [{ groupId: group.id }, ...members.map((repo) => ({ repoId: repo.id }))],
        orgId,
        tasks: Promise.resolve(tasks),
      },
      rows,
    );
    const head = headOf(rows);
    const current = currentOf(rows);
    const view: ReleaseView = {
      preview: previewRelease(inputs),
      head: head ? summaryOf(head, rows) : null,
      current: current ? summaryOf(current, rows) : null,
    };
    return { members, owner, inputs, view };
  };

  const release = async (
    response: ServerResponse,
    user: User,
    tenant: { id: number; login: string; kind: "org" | "user"; avatarUrl?: string },
    group: RepositoryGroup,
    rows: GroupReleaseRow[],
    body: z.infer<typeof releaseRequest>,
  ) => {
    const { members, owner, inputs, view } = await gather(tenant.id, group, rows);
    // The page names every member, so each must still be here to be scored and checked.
    if (members.length < group.repositoryIds.length) {
      const error =
        "A repository in this group is no longer connected. Reconnect or remove it in Settings first.";
      sendJson(response, 400, { error });
      return;
    }
    const head = headOf(rows);
    if (body.head !== (head?.id ?? null) || body.fingerprint !== view.preview.fingerprint) {
      sendJson(response, 409, {
        error:
          "Results, tasks, or releases changed since you opened this. Review the refreshed preview.",
        ...view,
      });
      return;
    }
    const token = await options.users.gitHubToken(user.githubId);
    if (!token) throw new GitHubOAuthError("no GitHub token stored for this user", 401);
    // Checked live: any member may have turned private since it was connected.
    const repositories: GroupMember["repository"][] = [];
    for (const repo of members) {
      const github = await lookupRepositoryById(
        options.githubApiUrl,
        token,
        repo.githubId,
        fetchImpl,
      ).catch(() => undefined);
      if (!github) {
        sendJson(response, 503, {
          error: `GitHub could not confirm that ${repo.fullName} is public. Try again in a moment.`,
        });
        return;
      }
      if (github.private) {
        sendJson(response, 400, {
          error: `${repo.fullName} is private. Only groups of public repositories can be released.`,
        });
        return;
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
    let built: ReturnType<typeof buildRelease>;
    try {
      built = buildRelease(inputs, body.settings, {
        repository: { id: group.id, fullName: group.name },
        publisher: { login: tenant.login, kind: tenant.kind },
      });
    } catch (error) {
      if (!(error instanceof ReleaseRefused)) throw error;
      sendJson(response, 400, { error: error.message });
      return;
    }
    const { settings: _settings, frontier, tasks } = built.payload;
    const keyed = built.payload.settings.map((setting, index) => ({
      id: setting.id,
      key: built.detail.settings[index] ?? "",
    }));
    const results = (built.detail.results ?? {}) as Parameters<typeof membersOf>[3];
    // What the page shows besides the scores: the group's own fields and its members, in order.
    const hash = sha256(
      canonicalJson({
        scores: built.hash,
        group: [group.slug, group.name, group.description],
        // Who they are and in what order; stars and avatars drift without changing the release.
        members: repositories.map(({ id, fullName }) => [id, fullName]),
      }),
    );
    const current = currentOf(rows);
    if (current && current.hash === hash && headOf(rows)?.id === head?.id) {
      sendJson(response, 200, { unchanged: true, release: summaryOf(current, rows) });
      return;
    }
    try {
      const row = await options.releases.insert({
        groupId: group.id,
        orgId: tenant.id,
        slug: group.slug,
        publisherLogin: tenant.login,
        ...(head ? { predecessorId: head.id } : {}),
        releasedBy: { id: user.id, login: user.login },
        hash,
        payload: {
          publisher: {
            login: tenant.login,
            kind: tenant.kind,
            ...(tenant.avatarUrl ? { avatarUrl: tenant.avatarUrl } : {}),
          },
          slug: group.slug,
          name: group.name,
          ...(group.description ? { description: group.description } : {}),
          members: membersOf(repositories, owner, keyed, results),
          tasks,
          settings: built.payload.settings,
          frontier,
        },
        detail: built.detail,
      });
      options.onPublicChange?.(["/", groupHref(tenant.login, group.slug)]);
      track(user, "group release published", { group: group.slug }, tenant);
      const after = await options.releases.list(group.id);
      sendJson(response, 201, { release: summaryOf(row, after) });
    } catch (error) {
      if (!(error instanceof ReleaseConflict)) throw error;
      const after = await options.releases.list(group.id);
      sendJson(response, 409, {
        error: "Someone else released first. Review the refreshed preview.",
        ...(await gather(tenant.id, group, after)).view,
      });
    }
  };

  return {
    /** Answers /api/orgs/:org/groups/:slug/releases; true when the response was sent. */
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
      const tenant = await tenantFor(options.users, user, match[1]);
      const group = tenant ? await options.groups.find(tenant.id, match[2]) : undefined;
      if (!tenant || !group) {
        sendJson(response, 404, { error: "Group not found" });
        return true;
      }
      const mutation = request.method === "POST";
      if (mutation && !trustedMutation(request, options.publicUrl, user)) {
        sendJson(response, 403, { error: "Same-origin JSON request required" });
        return true;
      }
      const rows = await options.releases.list(group.id);
      if (request.method === "GET" && !section) {
        const list: ReleaseList = {
          releases: rows.map((row) => summaryOf(row, rows)),
          resultsSiteUrl: options.resultsSiteUrl,
        };
        sendJson(response, 200, list);
      } else if (request.method === "GET" && section === "preview") {
        sendJson(response, 200, (await gather(tenant.id, group, rows)).view);
      } else if (mutation && section && section !== "preview" && action === "withdraw") {
        const withdrawn = z.uuid().safeParse(section).success
          ? await options.releases.withdraw(group.id, section, user.login)
          : undefined;
        if (!withdrawn) {
          sendJson(response, 404, { error: "Release not found or already withdrawn" });
        } else {
          options.onPublicChange?.(["/", groupHref(withdrawn.publisherLogin, withdrawn.slug)]);
          sendJson(response, 200, {
            release: summaryOf(withdrawn, await options.releases.list(group.id)),
          });
        }
      } else if (mutation && !section) {
        const body = releaseRequest.parse(
          JSON.parse((await readBody(request, 1024 * 1024)).toString()),
        );
        await release(response, user, tenant, group, rows, body);
      } else sendJson(response, 405, { error: "Method not allowed" });
      return true;
    },
  };
}
export type GroupReleaseRoutes = ReturnType<typeof createGroupReleaseRoutes>;
