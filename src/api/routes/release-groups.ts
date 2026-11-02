import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  type GroupFields,
  GroupSlugTaken,
  type ReleaseGroupRow,
  type ReleaseGroupStore,
} from "../../db/release-groups.js";
import type { ReleaseStore } from "../../db/releases.js";
import type { RepoStore } from "../../db/repos.js";
import type { Org, User, UserStore } from "../../db/users.js";
import { track } from "../../lib/telemetry/posthog.js";
import { GROUP_SLUG, GROUP_SLUG_MAX } from "../../public/paths.js";
import type { GroupCandidate, GroupList, GroupSummary } from "../../public/release-group-views.js";
import { groupHref } from "../../public/release-groups.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";

const NAME = "([A-Za-z0-9_.-]+)";
const route = new RegExp(`^/api/orgs/${NAME}/release-groups(?:/([a-f0-9-]{36}))?$`);

/** A group needs two members to pool anything; past this a page is too long to read. */
const MEMBERS = { min: 2, max: 50 };

const groupRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: z.string().max(GROUP_SLUG_MAX).regex(GROUP_SLUG),
    description: z.string().trim().max(300).default(""),
    repositoryIds: z
      .array(z.number().int().positive())
      .min(MEMBERS.min)
      .max(MEMBERS.max)
      .refine((ids) => new Set(ids).size === ids.length, "Repositories must not repeat"),
  })
  .strict();

export interface ReleaseGroupRoutesOptions {
  readonly users: UserStore;
  readonly repos: RepoStore;
  readonly releases: Pick<ReleaseStore, "currentLinesOf">;
  readonly groups: ReleaseGroupStore;
  readonly publicUrl: string;
  readonly resultsSiteUrl: string | null;
  /** Told the group page's path whenever a group is saved or deleted. */
  readonly onPublicChange?: (paths: string[]) => void;
}

export function createReleaseGroupRoutes(options: ReleaseGroupRoutesOptions) {
  const { users, repos, releases, groups } = options;

  const candidatesOf = async (tenant: Org): Promise<GroupCandidate[]> =>
    (await releases.currentLinesOf(tenant.id))
      .map(({ release }) => ({
        id: release.repository.id,
        fullName: release.repository.fullName,
        releasedAt: release.releasedAt,
        tasks: release.tasks,
        settingIds: release.settings.map((setting) => setting.id),
      }))
      .sort((left, right) => left.fullName.localeCompare(right.fullName));

  const summaryOf = (
    row: ReleaseGroupRow,
    candidates: readonly GroupCandidate[],
    names: ReadonlyMap<number, string>,
  ): GroupSummary => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    publicUrl: options.resultsSiteUrl
      ? `${options.resultsSiteUrl}${groupHref(row.publisherLogin, row.slug)}`
      : null,
    repositories: row.repositoryIds.map((id) => {
      const released = candidates.find((candidate) => candidate.id === id);
      return {
        id,
        fullName: released?.fullName ?? names.get(id) ?? `Repository ${id}`,
        released: released !== undefined,
      };
    }),
    updatedAt: row.updatedAt,
    updatedBy: row.updatedByLogin,
  });

  const changed = (row: ReleaseGroupRow, before?: ReleaseGroupRow) => {
    const paths = new Set(["/", groupHref(row.publisherLogin, row.slug)]);
    if (before) paths.add(groupHref(before.publisherLogin, before.slug));
    options.onPublicChange?.([...paths]);
  };

  /** Saves a new group or an existing one, or answers why not. */
  const save = async (
    request: IncomingMessage,
    response: ServerResponse,
    user: User,
    tenant: Org,
    id: string | undefined,
  ) => {
    const body = groupRequest.parse(JSON.parse((await readBody(request, 64 * 1024)).toString()));
    const candidates = await candidatesOf(tenant);
    const existing = id ? (await groups.list(tenant.id)).find((row) => row.id === id) : undefined;
    if (id && !existing) {
      sendJson(response, 404, { error: "Group not found" });
      return;
    }
    // A member already in the group may stay while it has no current release; a new one must
    // have one, or the page would show nothing of it.
    const kept = new Set(existing?.repositoryIds ?? []);
    const unreleased = body.repositoryIds.filter(
      (repositoryId) =>
        !kept.has(repositoryId) && !candidates.some((candidate) => candidate.id === repositoryId),
    );
    if (unreleased.length > 0) {
      sendJson(response, 400, {
        error: "Add only repositories this workspace has released. Release them first.",
      });
      return;
    }
    const fields: GroupFields = { ...body, publisherLogin: tenant.login };
    try {
      const row = existing
        ? await groups.update(tenant.id, existing.id, fields, user)
        : await groups.insert(tenant.id, fields, user);
      if (!row) {
        sendJson(response, 404, { error: "Group not found" });
        return;
      }
      changed(row, existing);
      track(
        user,
        existing ? "release group updated" : "release group created",
        { slug: row.slug, repositories: row.repositoryIds.length },
        tenant,
      );
      const names = new Map(
        (await repos.list(tenant.id)).map((repo) => [repo.githubId, repo.fullName]),
      );
      sendJson(response, existing ? 200 : 201, { group: summaryOf(row, candidates, names) });
    } catch (error) {
      if (!(error instanceof GroupSlugTaken)) throw error;
      sendJson(response, 409, {
        error: `This workspace already has a group at /${body.slug}. Choose another address.`,
      });
    }
  };

  return {
    /** Answers /api/orgs/:org/release-groups[/:id]; true when the response was sent. */
    async handle(
      request: IncomingMessage,
      url: URL,
      response: ServerResponse,
      user: User,
    ): Promise<boolean> {
      const match = route.exec(url.pathname);
      if (!match?.[1]) return false;
      response.setHeader("cache-control", "no-store");
      const tenant = await tenantFor(users, user, match[1]);
      if (!tenant) {
        sendJson(response, 404, { error: "Workspace not found" });
        return true;
      }
      const id = match[2];
      const method = request.method ?? "GET";
      if (method !== "GET" && !trustedMutation(request, options.publicUrl, user)) {
        sendJson(response, 403, { error: "Same-origin JSON request required" });
        return true;
      }
      if (method === "GET" && !id) {
        const [rows, candidates, connected] = await Promise.all([
          groups.list(tenant.id),
          candidatesOf(tenant),
          repos.list(tenant.id),
        ]);
        const names = new Map(connected.map((repo) => [repo.githubId, repo.fullName]));
        const list: GroupList = {
          groups: rows.map((row) => summaryOf(row, candidates, names)),
          candidates,
          resultsSiteUrl: options.resultsSiteUrl,
        };
        sendJson(response, 200, list);
      } else if (method === "POST" && !id) {
        await save(request, response, user, tenant, undefined);
      } else if (method === "PUT" && id) {
        await save(request, response, user, tenant, id);
      } else if (method === "DELETE" && id) {
        const removed = await groups.remove(tenant.id, id);
        if (!removed) {
          sendJson(response, 404, { error: "Group not found" });
          return true;
        }
        changed(removed);
        track(user, "release group deleted", { slug: removed.slug }, tenant);
        sendJson(response, 200, { deleted: removed.id });
      } else sendJson(response, 405, { error: "Method not allowed" });
      return true;
    },
  };
}
export type ReleaseGroupRoutes = ReturnType<typeof createReleaseGroupRoutes>;
