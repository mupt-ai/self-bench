import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { ComparisonRecord } from "../../db/comparisons.js";
import { RecordStoreError } from "../../db/encrypted-records.js";
import type { RepoStore } from "../../db/repos.js";
import type { TaskStore } from "../../db/tasks.js";
import type { User, UserStore } from "../../db/users.js";
import type { Vault } from "../../db/vault.js";
import {
  catalog,
  catalogVersion,
  hostedSandboxes,
  withReferencePricing,
} from "../../evaluation/catalog.js";
import {
  comparisonSchema,
  comparisonStatus,
  createComparison,
  dispatchComparison,
} from "../../evaluation/comparisons.js";
import { evaluationPrefix, getEvaluation, listEvaluations } from "../../evaluation/store.js";
import type { EvaluationInput } from "../../evaluation/types.js";
import { managedOffer } from "../../generation/billing/managed.js";
import type { CodexLogins } from "../../harnesses/codex/login.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import { credentialRoutes } from "./credentials.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/evaluations(?:\/(options|catalog|comparisons|[a-f0-9-]{36}))?(?:\/(artifacts|[a-f0-9-]{36}))?(?:\/(resume))?$/;

export interface EvaluationRoutesOptions {
  users: UserStore;
  repos: RepoStore;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  publicUrl: string;
  start(input: EvaluationInput): Promise<void>;
  env?: NodeJS.ProcessEnv;
  vault?: Vault;
  codexLogins?: CodexLogins;
}

export function createEvaluationRoutes(options: EvaluationRoutesOptions) {
  const { users, repos, tasks, artifacts } = options;
  return {
    async handle(
      request: IncomingMessage,
      url: URL,
      response: ServerResponse,
      user: User,
    ): Promise<boolean> {
      if (await credentialRoutes(options, request, url, response, user)) return true;
      const match = route.exec(url.pathname);
      if (!match?.[1] || !match[2] || !match[3]) return false;
      response.setHeader("cache-control", "no-store");
      const tenant = await tenantFor(users, user, match[1]);
      const repo = tenant ? await repos.find(tenant.id, `${match[2]}/${match[3]}`) : undefined;
      if (!tenant || !repo) {
        sendJson(response, 404, { error: "Repository is not connected here" });
        return true;
      }
      const env = options.env ?? process.env;
      const [section, id, action] = [match[4], match[5], match[6]];
      if (section === "comparisons") {
        if (
          request.method !== "GET" &&
          (request.method !== "POST" || !trustedMutation(request, options.publicUrl, user))
        ) {
          sendJson(response, 403, { error: "Same-origin JSON request required" });
          return true;
        }
        try {
          if (!options.vault) throw new RecordStoreError(503);
          const vault = options.vault;
          const resume = async (record: ComparisonRecord, message: string) => {
            let submissionError: string | undefined;
            try {
              await dispatchComparison(artifacts, record, options.start);
            } catch {
              submissionError = message;
            }
            sendJson(response, 202, {
              ...(await comparisonStatus(artifacts, record)),
              submissionError,
            });
          };
          if (request.method === "POST" && !id) {
            const draft = comparisonSchema.parse(
              JSON.parse((await readBody(request, 30_000)).toString()),
            );
            const record = await createComparison(
              vault,
              tasks,
              artifacts,
              managedOffer(env),
              { repoId: repo.id, orgId: tenant.id, tenant: tenant.login, login: user.login },
              draft,
            );
            await resume(
              record,
              "Comparison saved. Some submissions were not confirmed; resume safely using this comparison.",
            );
          } else if (request.method === "GET" && !id) {
            const records = await vault.comparisons.listForRepo(repo.id);
            sendJson(response, 200, {
              comparisons: await Promise.all(
                records.map((record) => comparisonStatus(artifacts, record)),
              ),
            });
          } else {
            const record = id ? await vault.comparisons.find(id) : undefined;
            if (!record || record.repoId !== repo.id)
              sendJson(response, 404, { error: "Comparison not found" });
            else if (request.method === "GET" && !action)
              sendJson(response, 200, await comparisonStatus(artifacts, record));
            else if (request.method === "POST" && action === "resume")
              await resume(record, "Submission not confirmed. Resume uses the same run IDs.");
            else sendJson(response, 405, { error: "Method not allowed" });
          }
        } catch (error) {
          if (error instanceof RecordStoreError)
            sendJson(response, error.status, { error: error.message });
          else
            sendJson(response, 400, {
              error:
                error instanceof Error && error.name !== "ZodError"
                  ? error.message
                  : "Invalid selection or credential fields",
            });
        }
        request.resume();
        return true;
      }
      if (request.method !== "GET" || action) {
        sendJson(response, 405, { error: "Method not allowed" });
        return true;
      }
      if (section === "catalog") {
        sendJson(response, 200, {
          version: catalogVersion,
          models: catalog.map(withReferencePricing),
          sandboxes: hostedSandboxes,
          customHosts: (env.SELFBENCH_CUSTOM_MODEL_HOSTS ?? "").split(",").filter(Boolean),
          managed: managedOffer(env),
        });
      } else if (section === "options") {
        const available = (await tasks.listForRepo(repo.id)).filter(
          (task) =>
            task.bundleKey &&
            task.pipelineStatus === "accepted" &&
            task.review?.decision === "approve",
        );
        sendJson(response, 200, {
          tasks: available.map((task) => ({
            runId: task.runId,
            taskId: task.taskId,
            difficulty: task.difficulty,
          })),
        });
      } else if (section) {
        const run = await getEvaluation(artifacts, repo.id, section);
        if (!run) sendJson(response, 404, { error: "Evaluation not found" });
        else if (id === "artifacts") await sendArtifact(artifacts, repo.id, run, url, response);
        else if (!id) sendJson(response, 200, run);
        else sendJson(response, 404, { error: "Not found" });
      } else {
        sendJson(response, 200, {
          runs: (await listEvaluations(artifacts, repo.id)).map((run) => ({
            ...run,
            trials: run.trials.map((trial) => ({ ...trial, log: "", steps: [], artifacts: [] })),
          })),
        });
      }
      return true;
    },
  };
}

async function sendArtifact(
  artifacts: ArtifactStore,
  repoId: number,
  run: NonNullable<Awaited<ReturnType<typeof getEvaluation>>>,
  url: URL,
  response: ServerResponse,
) {
  const name = url.searchParams.get("name") ?? "";
  const bytes = run.trials.some((trial) => trial.artifacts.includes(name))
    ? await artifacts.getByKey(`${evaluationPrefix(repoId, run.id)}artifacts/${name}`)
    : undefined;
  if (!bytes) {
    sendJson(response, 404, { error: "Artifact not found" });
    return;
  }
  response.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "content-disposition": "attachment; filename=solver-artifact.txt",
  });
  response.end(bytes);
}
