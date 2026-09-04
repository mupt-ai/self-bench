import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../api/http.js";
import type { AuthConfig } from "../auth/config.js";
import { GitHubOAuthError } from "../auth/github.js";
import type { User, UserStore } from "../auth/users.js";
import { lookupRepo } from "./github-repos.js";
import type { ConnectedRepo, RepoStore } from "./repo-store.js";
import { tenantFor } from "./tenant.js";

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
        if (!token) throw new GitHubOAuthError("no GitHub token stored for this user");
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
        sendJson(response, existing ? 200 : 201, { repo: publicRepo(repo) });
        return true;
      }
      if (item?.[2] && item[3] && request.method === "PATCH") {
        const body = JSON.parse((await readBody(request, 64 * 1024)).toString("utf8") || "{}") as {
          continuous?: unknown;
        };
        if (typeof body.continuous !== "boolean") {
          sendJson(response, 400, { error: "continuous must be a boolean" });
          return true;
        }
        const repo = await repos.setContinuous(tenant.id, `${item[2]}/${item[3]}`, body.continuous);
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

/** The browser-facing shape of a connected repo. */
export function publicRepo(repo: ConnectedRepo): {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  continuous: boolean;
  connectedBy: string;
  connectedAt: string;
} {
  return {
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    private: repo.private,
    continuous: repo.continuous,
    connectedBy: repo.connectedBy.login,
    connectedAt: repo.connectedAt,
  };
}
