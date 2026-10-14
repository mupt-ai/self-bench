import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { BenchmarkStore } from "../../db/benchmarks.js";
import type { RepoStore } from "../../db/repos.js";
import type { TaskStore } from "../../db/tasks.js";
import type { User, UserStore } from "../../db/users.js";
import type { Vault } from "../../db/vault.js";
import type { StopEvaluation } from "../../evaluation/cancel.js";
import type { EvaluationInput } from "../../evaluation/types.js";
import type { ClaudeLogins } from "../../harnesses/claude-code/login.js";
import type { CodexLogins } from "../../harnesses/codex/login.js";
import type { MuseLogins } from "../../harnesses/muse-code/login.js";
import type { runCommand } from "../../lib/process.js";
import { tenantFor } from "../auth/tenant.js";
import { sendJson } from "../http.js";
import { benchmarkRoutes } from "./benchmarks.js";
import { credentialRoutes } from "./credentials.js";
import { handleScopedEvaluations } from "./evaluation-scope.js";

const repoRoute =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/evaluations(?:\/(options|catalog|comparisons|[a-f0-9-]{36}))?(?:\/(artifacts|[a-f0-9-]{36}))?(?:\/(resume|cancel))?$/;
export interface EvaluationRoutesOptions {
  users: UserStore;
  repos: RepoStore;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  publicUrl: string;
  start(input: EvaluationInput): Promise<void>;
  stop: StopEvaluation;
  env?: NodeJS.ProcessEnv;
  /** Reaches OpenRouter for a gateway model's vendor list price (runPricing). */
  fetch?: typeof fetch;
  /** Runs Harbor to download a benchmark's registry tasks (freezeRegistryTasks). */
  registryCommand?: typeof runCommand;
  /** The org's benchmarks (Harbor registry datasets); without them, no benchmark routes. */
  benchmarks?: BenchmarkStore;
  vault?: Vault;
  codexLogins?: CodexLogins;
  claudeLogins?: ClaudeLogins;
  museLogins?: MuseLogins;
}

export function createEvaluationRoutes(options: EvaluationRoutesOptions) {
  const { users, repos } = options;
  return {
    async handle(
      request: IncomingMessage,
      url: URL,
      response: ServerResponse,
      user: User,
    ): Promise<boolean> {
      if (await credentialRoutes(options, request, url, response, user)) return true;
      if (await benchmarkRoutes(options, request, url, response, user)) return true;
      const repoMatch = repoRoute.exec(url.pathname);
      if (repoMatch?.[1] && repoMatch[2] && repoMatch[3]) {
        response.setHeader("cache-control", "no-store");
        const tenant = await tenantFor(users, user, repoMatch[1]);
        const repo = tenant
          ? await repos.find(tenant.id, `${repoMatch[2]}/${repoMatch[3]}`)
          : undefined;
        if (!tenant || !repo) {
          sendJson(response, 404, { error: "Repository is not connected here" });
          return true;
        }
        const owner = {
          scope: { repoId: repo.id },
          agentMinutes: repo.agentMinutes,
          orgId: tenant.id,
          tenant: tenant.login,
          login: user.login,
        };
        const [section, id, action] = [repoMatch[4], repoMatch[5], repoMatch[6]];
        await handleScopedEvaluations(options, {
          request,
          url,
          response,
          user,
          owner,
          tenant,
          section,
          id,
          action,
        });
        return true;
      }
      return false;
    },
  };
}
