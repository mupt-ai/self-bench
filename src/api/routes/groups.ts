import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { GroupSlugTaken, type RepositoryGroup } from "../../db/groups.js";
import { type ConnectedRepo, isGitHubRepo } from "../../db/repos.js";
import { isVariant, runnable } from "../../db/task-record.js";
import type { User } from "../../db/users.js";
import { groupDataset } from "../../evaluation/dataset.js";
import { track } from "../../lib/telemetry/posthog.js";
import type { GroupList, GroupView } from "../../public/group-views.js";
import { GROUP_SLUG, GROUP_SLUG_MAX } from "../../public/paths.js";
import { groupHref, isGroupLogo } from "../../public/release-groups.js";
import { readBody } from "../http.js";
import { EVALUATIONS_PATH, handleScopedEvaluations } from "./evaluation-scope.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";
import { openOrgScope, unfinishedRuns } from "./org-scope.js";

/** `/api/orgs/<org>/groups`, or one group (`<slug>`) and what follows it. */
const route = /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/groups(?:\/([a-z0-9-]{1,60})(\/.*)?)?$/;

/** A group pools two repositories at least; past this a page is too long to read. */
const MEMBERS = { min: 2, max: 50 };

const groupRequest = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: z.string().max(GROUP_SLUG_MAX).regex(GROUP_SLUG),
    description: z.string().trim().max(300).default(""),
    logo: z
      .string()
      .refine(isGroupLogo, "The logo must be a PNG, JPEG, WebP, or SVG image under 48 KB")
      .nullable()
      .optional(),
    repositoryIds: z
      .array(z.number().int().positive())
      .min(MEMBERS.min)
      .max(MEMBERS.max)
      .refine((ids) => new Set(ids).size === ids.length, "Repositories must not repeat"),
  })
  .strict();

/** Whether a repository may be private now (evaluations.ts `privateNow`). */
export type PrivateNow = (repo: ConnectedRepo, user: User) => Promise<boolean>;

/**
 * A workspace's repository groups: listed, created, edited, deleted, and each one's evaluations,
 * served exactly as a repository's are, over its members' approved tasks. True when the response
 * has been sent.
 */
export async function groupRoutes(
  options: EvaluationRoutesOptions,
  privateNow: PrivateNow,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
): Promise<boolean> {
  const match = route.exec(url.pathname);
  if (!match?.[1]) return false;
  const [, login, slug, rest = ""] = match;
  // A group's releases are answered by group-releases.ts.
  if (rest === "/releases" || rest.startsWith("/releases/")) return false;
  const store = options.groups;
  const opened = await openOrgScope(options, request, response, user, login ?? "", !!store);
  if ("sent" in opened || !store) return true;
  const { tenant, send } = opened;
  const method = request.method ?? "GET";
  // A group gathers GitHub repositories; an eval has none, so it is never a member.
  const connected = (await options.repos.list(tenant.id)).filter(isGitHubRepo);
  const approved = async (repo: ConnectedRepo) =>
    (await options.tasks.listForRepo(repo.id)).filter(runnable).filter((task) => !isVariant(task))
      .length;
  const viewOf = async (group: RepositoryGroup): Promise<GroupView> => {
    const repositories = await Promise.all(
      group.repositoryIds.map(async (id) => {
        const repo = connected.find((each) => each.githubId === id);
        return {
          id,
          fullName: repo?.fullName ?? `Repository ${id}`,
          connected: repo !== undefined,
          tasks: repo ? await approved(repo) : 0,
        };
      }),
    );
    return {
      slug: group.slug,
      name: group.name,
      description: group.description,
      logo: group.logo,
      repositories,
      tasks: repositories.reduce((sum, each) => sum + each.tasks, 0),
      updatedAt: group.updatedAt,
      updatedBy: group.updatedBy,
    };
  };
  /** Parses a save, refusing members that are not connected here. */
  const fieldsOf = async () => {
    const body = groupRequest.parse(JSON.parse((await readBody(request, 128 * 1024)).toString()));
    const unknown = body.repositoryIds.filter(
      (id) => !connected.some((repo) => repo.githubId === id),
    );
    return { body, unknown };
  };

  if (!slug) {
    if (method === "GET") {
      const groups = await store.list(tenant.id);
      const list: GroupList = {
        groups: await Promise.all(groups.map(viewOf)),
        repositories: await Promise.all(
          connected.map(async (repo) => ({
            id: repo.githubId,
            fullName: repo.fullName,
            tasks: await approved(repo),
          })),
        ),
      };
      return send([200, list]);
    }
    if (method !== "POST") return send([405, { error: "Method not allowed" }]);
    const { body, unknown } = await fieldsOf();
    if (unknown.length > 0)
      return send([400, { error: "Add only repositories connected to this workspace." }]);
    try {
      const group = await store.insert(tenant.id, body, user);
      track(user, "repository group created", { repositories: body.repositoryIds.length }, tenant);
      return send([201, { group: await viewOf(group) }]);
    } catch (error) {
      if (!(error instanceof GroupSlugTaken)) throw error;
      return send([409, { error: `This workspace already has a group at /${body.slug}.` }]);
    }
  }

  const group = await store.find(tenant.id, slug);
  if (!group) return send([404, { error: "Group not found" }]);
  const members = group.repositoryIds.flatMap((id) => {
    const repo = connected.find((each) => each.githubId === id);
    return repo ? [repo] : [];
  });
  const evaluations = EVALUATIONS_PATH.exec(rest);
  if (evaluations) {
    const [, section, id, action] = evaluations;
    if (section === "exports") return send([404, { error: "Not found" }]);
    // A group's tasks get as long as its most generous member gives its own.
    const agentMinutes = Math.max(...members.map((repo) => repo.agentMinutes));
    const starting = section === "comparisons" && !id && method === "POST";
    await handleScopedEvaluations(options, {
      request,
      url,
      response,
      user,
      owner: {
        scope: { groupId: group.id },
        ...(members.length > 0 ? { agentMinutes } : {}),
        orgId: tenant.id,
        tenant: tenant.login,
        login: user.login,
        // Run Missing skips what a member's own runs already finished, as Results counts those.
        sources: members.map((repo) => ({ repoId: repo.id })),
        // Failures may be explained only when every member is public.
        ...(starting
          ? {
              privateRepo: (await Promise.all(members.map((repo) => privateNow(repo, user)))).some(
                Boolean,
              ),
            }
          : {}),
      },
      tenant,
      dataset: groupDataset(
        options.tasks,
        members.map((repo) => ({ repoId: repo.id, fullName: repo.fullName })),
      ),
      section,
      id,
      action,
      properties: { group: group.slug },
    });
    return true;
  }
  if (rest !== "") return send([404, { error: "Not found" }]);
  if (method === "GET") return send([200, { group: await viewOf(group) }]);
  if (method === "PUT") {
    const { body, unknown } = await fieldsOf();
    // A member disconnected since may stay; a new one must be connected.
    if (unknown.some((id) => !group.repositoryIds.includes(id)))
      return send([400, { error: "Add only repositories connected to this workspace." }]);
    try {
      const saved = await store.update(tenant.id, group.slug, body, user);
      if (!saved) return send([404, { error: "Group not found" }]);
      return send([200, { group: await viewOf(saved) }]);
    } catch (error) {
      if (!(error instanceof GroupSlugTaken)) throw error;
      return send([409, { error: `This workspace already has a group at /${body.slug}.` }]);
    }
  }
  if (method === "DELETE") {
    const refused = await unfinishedRuns(options, { groupId: group.id }, "group");
    if (refused) return send(refused);
    // Its page goes with it: nothing would be left to withdraw it from.
    const withdrawn = await options.publicLines?.store.withdrawLine(
      { orgId: tenant.id, groupId: group.id },
      user.login,
    );
    if (withdrawn) options.publicLines?.changed?.(["/", groupHref(tenant.login, group.slug)]);
    await store.remove(tenant.id, group.slug);
    track(user, "repository group deleted", {}, tenant);
    return send([200, { ok: true }]);
  }
  return send([405, { error: "Method not allowed" }]);
}
