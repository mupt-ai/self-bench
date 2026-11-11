import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { User } from "../../db/users.js";
import { WorkspaceError } from "../../db/workspaces.js";
import { apiHeaders } from "../../third_party/github/oauth.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

const pattern =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/(members|invites|settings|github)(?:\/([A-Za-z0-9_.-]+)(?:\/(delete|role))?)?$/;
const role = z.enum(["admin", "member"]);
// GitHub logins, and so workspace slugs: alphanumerics and single hyphens, at most 39 characters.
const login = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, "Not a valid name");
const inviteSchema = z.object({ login, role: role.default("member") }).strict();
const roleSchema = z.object({ role }).strict();
const settingsSchema = z.object({ name: z.string().trim().max(80).nullable() }).strict();
const createSchema = z.object({ login, name: z.string().trim().max(80).optional() }).strict();
const connectSchema = z.object({ login }).strict();

type Options = Pick<EvaluationRoutesOptions, "users" | "publicUrl" | "githubApiUrl" | "fetch">;

/**
 * Workspaces: creating one, and a workspace's members, pending invitations, connected GitHub
 * organizations, and display name. Any member reads them; admins change them. Members of a
 * connected GitHub organization join on their own at sign-in.
 */
export async function memberRoutes(
  options: Options,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
) {
  if (url.pathname === "/api/orgs") return createRoute(options, request, response, user);
  const match = pattern.exec(url.pathname);
  if (!match) return false;
  response.setHeader("cache-control", "no-store");
  const org = await tenantFor(options.users, user, match[1] ?? "");
  if (!org) {
    sendJson(response, 404, { error: "Organization not found" });
    return true;
  }
  const [collection, target, action] = [match[2], match[3], match[4]];
  const mutation = request.method !== "GET";
  if (
    mutation &&
    (org.role !== "admin" ||
      request.method !== "POST" ||
      !trustedMutation(request, options.publicUrl, user))
  ) {
    sendJson(response, 403, { error: "Organization admin and same-origin JSON request required" });
    return true;
  }
  const { users } = options;
  await answer(response, async () => {
    const body = async () => JSON.parse((await readBody(request, 4096)).toString());
    if (!mutation && !target && collection === "members")
      return [
        200,
        {
          members: await users.members(org.id),
          github: org.github,
          canManage: org.role === "admin",
        },
      ];
    if (!mutation && !target && collection === "invites")
      return [200, { invites: await users.invites(org.id) }];
    if (mutation && !target && collection === "invites") {
      const { login, role } = inviteSchema.parse(await body());
      return [201, await users.invite(org.id, login, role, user.id)];
    }
    if (mutation && target && action === "delete" && collection === "invites")
      return found(await users.revokeInvite(org.id, Number(target)), { deleted: true });
    if (mutation && target && action === "role" && collection === "members")
      return found(await users.setRole(org.id, target, roleSchema.parse(await body()).role), {
        updated: true,
      });
    if (mutation && target && action === "delete" && collection === "members")
      return found(await users.removeMember(org.id, target), { deleted: true });
    if (mutation && !target && collection === "settings") {
      await users.rename(org.id, settingsSchema.parse(await body()).name || null);
      return [200, { updated: true }];
    }
    if (mutation && !target && collection === "github") {
      await users.moveConnection(org.id, connectSchema.parse(await body()).login, user.id);
      return [200, { connected: true }];
    }
    return [405, { error: "Method not allowed" }];
  });
  return true;
}

/**
 * `POST /api/orgs` makes a shared workspace. Its name is public on releases, so it may not be a
 * GitHub account's login: that name belongs to the account's own workspace.
 */
async function createRoute(
  options: Options,
  request: IncomingMessage,
  response: ServerResponse,
  user: User,
) {
  response.setHeader("cache-control", "no-store");
  if (request.method !== "POST" || !trustedMutation(request, options.publicUrl, user)) {
    sendJson(response, 403, { error: "Same-origin JSON request required" });
    return true;
  }
  await answer(response, async () => {
    const { login, name } = createSchema.parse(
      JSON.parse((await readBody(request, 4096)).toString()),
    );
    if (await isGitHubAccount(options, user, login))
      throw new WorkspaceError(
        `${login} is a GitHub account; its members get its workspace when they sign in`,
      );
    return [201, await options.users.create(login, name || null, user.id)];
  });
  return true;
}

/** Whether GitHub has an account by this login; unknown counts as yes, so names stay unclaimed. */
async function isGitHubAccount(options: Options, user: User, login: string): Promise<boolean> {
  const token = await options.users.gitHubToken(user.githubId);
  if (!token || !options.githubApiUrl) return true;
  const response = await (options.fetch ?? fetch)(
    `${options.githubApiUrl}/users/${encodeURIComponent(login)}`,
    { headers: apiHeaders(token), signal: AbortSignal.timeout(10_000) },
  ).catch(() => undefined);
  return response?.status !== 404;
}

function found(ok: boolean, body: object): [number, object] {
  return ok ? [200, body] : [404, { error: "Not found" }];
}

async function answer(response: ServerResponse, run: () => Promise<[number, object]>) {
  try {
    const [status, body] = await run();
    sendJson(response, status, body);
  } catch (error) {
    if (error instanceof WorkspaceError) sendJson(response, 409, { error: error.message });
    else if (error instanceof z.ZodError || error instanceof SyntaxError)
      sendJson(response, 400, { error: "Invalid request" });
    else throw error;
  }
}
