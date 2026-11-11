import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { User } from "../../db/users.js";
import { WorkspaceError } from "../../db/workspaces.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

const pattern =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/(members|invites|settings)(?:\/([A-Za-z0-9_.-]+)(?:\/(delete|role))?)?$/;
const role = z.enum(["admin", "member"]);
// GitHub logins: alphanumerics and single hyphens, at most 39 characters.
const githubLogin = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/, "Not a GitHub login");
const inviteSchema = z.object({ login: githubLogin, role: role.default("member") }).strict();
const roleSchema = z.object({ role }).strict();
const settingsSchema = z.object({ name: z.string().trim().max(80).nullable() }).strict();

/**
 * A workspace's members, pending invitations, and display name: any member reads them; admins
 * invite, change roles, remove, and rename. Members of a connected GitHub organization join on
 * their own at sign-in.
 */
export async function memberRoutes(
  options: EvaluationRoutesOptions,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  user: User,
) {
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
  const body = async () => JSON.parse((await readBody(request, 4096)).toString());
  try {
    if (!mutation && !target && collection === "members") {
      sendJson(response, 200, {
        members: await users.members(org.id),
        github: org.github,
        canManage: org.role === "admin",
      });
    } else if (!mutation && !target && collection === "invites") {
      sendJson(response, 200, { invites: await users.invites(org.id) });
    } else if (mutation && !target && collection === "invites") {
      const { login, role } = inviteSchema.parse(await body());
      sendJson(response, 201, await users.invite(org.id, login, role, user.id));
    } else if (mutation && target && action === "delete" && collection === "invites") {
      const removed = await users.revokeInvite(org.id, Number(target));
      sendJson(response, removed ? 200 : 404, removed ? { deleted: true } : { error: "Not found" });
    } else if (mutation && target && action === "role" && collection === "members") {
      const updated = await users.setRole(org.id, target, roleSchema.parse(await body()).role);
      sendJson(response, updated ? 200 : 404, updated ? { updated: true } : { error: "Not found" });
    } else if (mutation && target && action === "delete" && collection === "members") {
      const removed = await users.removeMember(org.id, target);
      sendJson(response, removed ? 200 : 404, removed ? { deleted: true } : { error: "Not found" });
    } else if (mutation && !target && collection === "settings") {
      await users.rename(org.id, settingsSchema.parse(await body()).name || null);
      sendJson(response, 200, { updated: true });
    } else sendJson(response, 405, { error: "Method not allowed" });
  } catch (error) {
    if (error instanceof WorkspaceError) sendJson(response, 409, { error: error.message });
    else if (error instanceof z.ZodError || error instanceof SyntaxError)
      sendJson(response, 400, { error: "Invalid request" });
    else throw error;
  }
  return true;
}
