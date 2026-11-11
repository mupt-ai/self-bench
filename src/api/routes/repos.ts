import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { AGENT_MINUTES } from "../../contracts/agent-limit.js";
import { EVAL_OWNER, evalSlug, isEvalName, MAX_EVAL_NAME_LENGTH } from "../../contracts/evals.js";
import type { ConnectedRepo, RepoStore } from "../../db/repos.js";
import type { User, UserStore } from "../../db/users.js";
import { track } from "../../lib/telemetry/posthog.js";
import { GitHubOAuthError } from "../../third_party/github/oauth.js";
import type { AuthConfig } from "../auth/config.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson } from "../http.js";
import { lookupRepo } from "./github-repos.js";

const ORG = "([A-Za-z0-9_.-]+)";
const REPO = "([A-Za-z0-9_.-]+)";
const listRoute = new RegExp(`^/api/orgs/${ORG}/repos$`);
const evalsRoute = new RegExp(`^/api/orgs/${ORG}/evals$`);
const evalSchema = z.strictObject({ name: z.string().trim().min(1).max(MAX_EVAL_NAME_LENGTH) });
const itemRoute = new RegExp(`^/api/orgs/${ORG}/repos/${REPO}/${REPO}$`);
const settingsSchema = z
  .strictObject({
    continuous: z.boolean().optional(),
    agentMinutes: z.int().min(AGENT_MINUTES.min).max(AGENT_MINUTES.max).optional(),
  })
  .refine((settings) => Object.keys(settings).length > 0);

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
      const evals = evalsRoute.exec(url.pathname);
      const orgLogin = list?.[1] ?? item?.[1] ?? evals?.[1];
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
      if (evals && request.method === "POST") {
        const body = evalSchema.safeParse(
          JSON.parse((await readBody(request, 64 * 1024)).toString("utf8") || "{}"),
        );
        const slug = body.success ? evalSlug(body.data.name) : "";
        if (!slug) {
          sendJson(response, 400, {
            error: `Name the eval: up to ${MAX_EVAL_NAME_LENGTH} characters, with a letter or digit.`,
          });
          return true;
        }
        const repo = await repos.createEval({ orgId: tenant.id, slug, createdBy: user.id });
        if (!repo) {
          sendJson(response, 409, { error: `This workspace already has an eval named ${slug}.` });
          return true;
        }
        track(user, "eval created", {}, tenant);
        sendJson(response, 201, { repo: publicRepo(repo) });
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
        if (isEvalName(fullName)) {
          sendJson(response, 400, { error: `${EVAL_OWNER} is reserved for evals` });
          return true;
        }
        const token = await users.gitHubToken(user.githubId);
        if (!token) throw new GitHubOAuthError("no GitHub token stored for this user", 401);
        const found = await lookupRepo(config, token, fullName, fetchImpl);
        if (!found) {
          sendJson(response, 404, { error: "repository not found or not readable" });
          return true;
        }
        // GitHub's own name decides, since the request may differ in case or follow a rename.
        if (isEvalName(found.fullName)) {
          sendJson(response, 400, { error: `${EVAL_OWNER} is reserved for evals` });
          return true;
        }
        // A shared workspace may connect anything public, but only private repositories owned
        // by a GitHub organization connected to it.
        const owner = (found.fullName.split("/")[0] ?? "").toLowerCase();
        if (
          tenant.kind === "org" &&
          found.private &&
          !tenant.github.some((account) => account.login.toLowerCase() === owner)
        ) {
          sendJson(response, 400, {
            error: `private repository is not owned by a GitHub organization connected to ${tenant.login}`,
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
        const settings = settingsSchema.safeParse(
          JSON.parse((await readBody(request, 64 * 1024)).toString("utf8") || "{}"),
        );
        if (!settings.success) {
          sendJson(response, 400, {
            error: `Set continuous (true or false) or agentMinutes (${AGENT_MINUTES.min}–${AGENT_MINUTES.max})`,
          });
          return true;
        }
        const repo = await repos.update(tenant.id, `${item[2]}/${item[3]}`, settings.data);
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
function publicRepo(repo: ConnectedRepo): {
  kind: ConnectedRepo["kind"];
  fullName: string;
  defaultBranch: string;
  private: boolean;
  continuous: boolean;
  agentMinutes: number;
  connectedBy: string;
  connectedAt: string;
} {
  return {
    kind: repo.kind,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    private: repo.private,
    continuous: repo.continuous,
    agentMinutes: repo.agentMinutes,
    connectedBy: repo.connectedBy.login,
    connectedAt: repo.connectedAt,
  };
}
