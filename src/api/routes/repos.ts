import type { IncomingMessage, ServerResponse } from "node:http";
import { AGENT_MINUTES, isAgentMinutes } from "../../contracts/agent-limit.js";
import type { ConnectedRepo, RepoSettings, RepoStore } from "../../db/repos.js";
import type { User, UserStore } from "../../db/users.js";
import { track } from "../../lib/telemetry/posthog.js";
import { isRecord } from "../../lib/util.js";
import { GitHubOAuthError } from "../../third_party/github/oauth.js";
import type { AuthConfig } from "../auth/config.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson } from "../http.js";
import { lookupRepo } from "./github-repos.js";

const ORG = "([A-Za-z0-9_.-]+)";
const REPO = "([A-Za-z0-9_.-]+)";
const listRoute = new RegExp(`^/api/orgs/${ORG}/repos$`);
const itemRoute = new RegExp(`^/api/orgs/${ORG}/repos/${REPO}/${REPO}$`);

export interface ConnectedRepoRoutesOptions {
  readonly config: Pick<AuthConfig, "githubApiUrl">;
  readonly users: UserStore;
  readonly repos: RepoStore;
  readonly fetchImpl?: typeof fetch;
}

export interface ConnectedRepoRoutes {
  /** Answers /api/orgs/:org/repos for a signed-in user. True when the response has been sent. */
  handle(
    request: IncomingMessage,
    url: URL,
    response: ServerResponse,
    user: User,
  ): Promise<boolean>;
}

export function createConnectedRepoRoutes(
  options: ConnectedRepoRoutesOptions,
): ConnectedRepoRoutes {
  const { config, users, repos } = options;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async handle(request, url, response, user) {
      const list = listRoute.exec(url.pathname);
      const item = itemRoute.exec(url.pathname);
      const orgLogin = list?.[1] ?? item?.[1];
      if (!orgLogin) return false;
      const tenant = await tenantFor(users, user, orgLogin);
      if (!tenant) {
        sendJson(response, 404, { error: "unknown organization" });
        return true;
      }
      if (list && request.method === "GET") {
        sendJson(response, 200, { repos: (await repos.list(tenant.id)).map(publicRepo) });
        return true;
      }
      if (list && request.method === "POST") {
        const body = JSON.parse((await readBody(request, 64 * 1024)).toString("utf8") || "{}") as {
          fullName?: unknown;
        };
        const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) {
          sendJson(response, 400, { error: "fullName must be owner/name" });
          return true;
        }
        const token = await users.gitHubToken(user.githubId);
        if (!token) throw new GitHubOAuthError("no GitHub token stored for this user", 401);
        const found = await lookupRepo(config, token, fullName, fetchImpl);
        if (!found) {
          sendJson(response, 404, { error: "repository not found or not readable" });
          return true;
        }
        // An org may connect anything public, but only its own private repositories.
        const owner = found.fullName.split("/")[0] ?? "";
        if (
          tenant.kind === "org" &&
          found.private &&
          owner.toLowerCase() !== tenant.login.toLowerCase()
        ) {
          sendJson(response, 400, {
            error: `private repository is not owned by ${tenant.login}`,
          });
          return true;
        }
        const existing = await repos.find(tenant.id, found.fullName);
        const repo =
          existing ??
          (await repos.connect({
            orgId: tenant.id,
            githubId: found.githubId,
            fullName: found.fullName,
            defaultBranch: found.defaultBranch,
            private: found.private,
            connectedBy: user.id,
          }));
        if (!existing)
          track(
            user,
            "repo connected",
            // A private repository's name stays out of analytics.
            { private: repo.private, ...(repo.private ? {} : { repo: repo.fullName }) },
            tenant,
          );
        sendJson(response, existing ? 200 : 201, { repo: publicRepo(repo) });
        return true;
      }
      if (item?.[2] && item[3] && request.method === "GET") {
        const repo = await repos.find(tenant.id, `${item[2]}/${item[3]}`);
        if (!repo) {
          sendJson(response, 404, { error: "not connected" });
          return true;
        }
        sendJson(response, 200, { repo: publicRepo(repo) });
        return true;
      }
      if (item?.[2] && item[3] && request.method === "PATCH") {
        const settings = repoSettings(
          JSON.parse((await readBody(request, 64 * 1024)).toString("utf8") || "{}"),
        );
        if (typeof settings === "string") {
          sendJson(response, 400, { error: settings });
          return true;
        }
        const repo = await repos.update(tenant.id, `${item[2]}/${item[3]}`, settings);
        if (!repo) {
          sendJson(response, 404, { error: "not connected" });
          return true;
        }
        sendJson(response, 200, { repo: publicRepo(repo) });
        return true;
      }
      if (item?.[2] && item[3] && request.method === "DELETE") {
        const removed = await repos.disconnect(tenant.id, `${item[2]}/${item[3]}`);
        sendJson(
          response,
          removed ? 200 : 404,
          removed ? { ok: true } : { error: "not connected" },
        );
        return true;
      }
      return false;
    },
  };
}

/** The settings a PATCH changes, or why the body is refused. */
function repoSettings(body: unknown): RepoSettings | string {
  if (!isRecord(body)) return "body must be an object";
  const { continuous, agentMinutes, ...rest } = body;
  if (Object.keys(rest).length > 0) return `unknown settings: ${Object.keys(rest).join(", ")}`;
  if (continuous === undefined && agentMinutes === undefined) return "no settings to change";
  if (continuous !== undefined && typeof continuous !== "boolean")
    return "continuous must be a boolean";
  if (agentMinutes !== undefined && !isAgentMinutes(agentMinutes))
    return `agentMinutes must be a whole number from ${AGENT_MINUTES.min} to ${AGENT_MINUTES.max}`;
  return {
    ...(continuous === undefined ? {} : { continuous }),
    ...(agentMinutes === undefined ? {} : { agentMinutes }),
  };
}

/** The browser-facing shape of a connected repo. */
function publicRepo(repo: ConnectedRepo): {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  continuous: boolean;
  agentMinutes: number;
  connectedBy: string;
  connectedAt: string;
} {
  return {
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    private: repo.private,
    continuous: repo.continuous,
    agentMinutes: repo.agentMinutes,
    connectedBy: repo.connectedBy.login,
    connectedAt: repo.connectedAt,
  };
}
