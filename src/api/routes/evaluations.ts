import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { RegistryDataset } from "../../contracts/harbor-registry.js";
import type { BenchmarkStore } from "../../db/benchmarks.js";
import type { GroupStore } from "../../db/groups.js";
import type { ReleaseStore } from "../../db/releases.js";
import { type ConnectedRepo, isGitHubRepo, type RepoStore } from "../../db/repos.js";
import type { TaskStore } from "../../db/tasks.js";
import type { User, UserStore } from "../../db/users.js";
import type { Vault } from "../../db/vault.js";
import type { BenchmarkAddInput } from "../../evaluation/benchmark-add.js";
import type { StopEvaluation } from "../../evaluation/cancel.js";
import { repositoryDataset } from "../../evaluation/dataset.js";
import type { FailureExplainer, ModelSummarizer, TaskAuditor } from "../../evaluation/start.js";
import type { EvaluationInput } from "../../evaluation/types.js";
import type { ClaudeLogins } from "../../harnesses/claude-code/login.js";
import type { CodexLogins } from "../../harnesses/codex/login.js";
import type { MuseLogins } from "../../harnesses/muse-code/login.js";
import { lookupRepositoryById } from "../../public/release-sources.js";
import type { inferResourceLimits } from "../../sandbox/resource-inference.js";
import { tenantFor } from "../auth/tenant.js";
import { sendJson } from "../http.js";
import { benchmarkRoutes } from "./benchmarks.js";
import { credentialRoutes } from "./credentials.js";
import { type CustomerExportRegistry, customerExportRoute } from "./customer-exports.js";
import { EVALUATIONS_PATH, handleScopedEvaluations } from "./evaluation-scope.js";
import { groupRoutes } from "./groups.js";
import { memberRoutes } from "./members.js";

/** A repository's evaluations: what follows it is EVALUATIONS_PATH. */
const repoRoute =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/evaluations(?:\/.*)?)$/;
export interface EvaluationRoutesOptions {
  /** Customer exports' registry grants; without it, exports are off. */
  customerExports?: CustomerExportRegistry;
  users: UserStore;
  repos: RepoStore;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  publicUrl: string;
  start(input: EvaluationInput): Promise<void>;
  stop: StopEvaluation;
  /** Explains failed trials on request (explainTrial); without it, none can be asked for. */
  explain?: FailureExplainer;
  /** Audits tasks on request (auditTaskRoute); without it, none can be asked for. */
  audit?: TaskAuditor;
  /** Summarizes configurations on request (modelSummariesRoute); without it, none can be asked for. */
  summarize?: ModelSummarizer;
  env?: NodeJS.ProcessEnv;
  /** Reaches GitHub. */
  fetch?: typeof fetch;
  /** Where GitHub's API is, to confirm a repository is still public before explaining failures. */
  githubApiUrl?: string;
  /**
   * Starts freezing a benchmark's registry tasks on a worker (selfBenchBenchmarkAddWorkflow);
   * without it, datasets can't be added.
   */
  addBenchmark?: (input: BenchmarkAddInput) => Promise<void>;
  /** Whether a box's add workflow is running now; a box `adding` with none running is restarted. */
  addRunning?: (id: number) => Promise<boolean>;
  /** The org's benchmarks (Harbor registry datasets); without them, no benchmark routes. */
  benchmarks?: BenchmarkStore;
  /** Harbor registry's public datasets, which the add box searches; without it, none are listed. */
  registryCatalog?: () => Promise<RegistryDataset[]>;
  /** The org's repository groups; without them, no group routes. */
  groups?: GroupStore;
  /**
   * Public release lines, which deleting a group or benchmark withdraws, and who is told the
   * pages that changed.
   */
  publicLines?: {
    store: Pick<ReleaseStore, "withdrawLine">;
    changed?: (paths: string[]) => void;
  };
  vault?: Vault;
  codexLogins?: CodexLogins;
  claudeLogins?: ClaudeLogins;
  museLogins?: MuseLogins;
  /** Reads a sandbox account's per-sandbox limits from its provider (resource-inference.ts). */
  inferResourceLimits?: typeof inferResourceLimits;
}

export function createEvaluationRoutes(options: EvaluationRoutesOptions) {
  const { users, repos } = options;
  /**
   * Whether the repository may be private: as connected, or as GitHub says now, since it may have
   * turned private since. Anything GitHub does not confirm counts as private.
   */
  const privateNow = async (repo: ConnectedRepo, user: User): Promise<boolean> => {
    // An eval has no GitHub repository, and is always private.
    if (repo.private || !options.githubApiUrl || !isGitHubRepo(repo)) return true;
    const token = await users.gitHubToken(user.githubId).catch(() => undefined);
    if (!token) return true;
    const github = await lookupRepositoryById(
      options.githubApiUrl,
      token,
      repo.githubId,
      options.fetch,
    ).catch(() => undefined);
    return github?.private !== false;
  };
  return {
    async handle(
      request: IncomingMessage,
      url: URL,
      response: ServerResponse,
      user: User,
    ): Promise<boolean> {
      if (await credentialRoutes(options, request, url, response, user)) return true;
      if (await memberRoutes(options, request, url, response, user)) return true;
      if (await benchmarkRoutes(options, request, url, response, user)) return true;
      if (await groupRoutes(options, privateNow, request, url, response, user)) return true;
      const repoMatch = repoRoute.exec(url.pathname);
      const path = repoMatch?.[4] ? EVALUATIONS_PATH.exec(repoMatch[4]) : null;
      if (repoMatch?.[1] && repoMatch[2] && repoMatch[3] && path) {
        response.setHeader("cache-control", "no-store");
        const tenant = await tenantFor(users, user, repoMatch[1]);
        const repo = tenant
          ? await repos.find(tenant.id, `${repoMatch[2]}/${repoMatch[3]}`)
          : undefined;
        if (!tenant || !repo) {
          sendJson(response, 404, { error: "Repository is not connected here" });
          return true;
        }
        const [, section, id, action] = path;
        if (section === "exports") {
          await customerExportRoute(
            options,
            request,
            response,
            { repoId: repo.id, orgId: tenant.id, user },
            id,
            action,
          );
          request.resume();
          return true;
        }
        const owner = {
          scope: { repoId: repo.id },
          agentMinutes: repo.agentMinutes,
          orgId: tenant.id,
          tenant: tenant.login,
          login: user.login,
          // Only a new comparison asks GitHub, to decide whether its failures may be explained.
          ...(section === "comparisons" && !id && request.method === "POST"
            ? { privateRepo: await privateNow(repo, user) }
            : {}),
        };
        await handleScopedEvaluations(options, {
          request,
          url,
          response,
          user,
          owner,
          tenant,
          dataset: repositoryDataset(options.tasks, repo.id),
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
