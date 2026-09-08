import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { readBody, sendJson } from "../api/http.js";
import type { ArtifactStore } from "../artifacts.js";
import type { User, UserStore } from "../auth/users.js";
import type { RepoStore } from "../site/repo-store.js";
import type { TaskStore } from "../site/task-store.js";
import { tenantFor } from "../site/tenant.js";
import { evaluationSandboxes } from "./config.js";
import type { EncryptedRecordStore } from "./encrypted-records.js";
import { orgCredentialRoutes } from "./org-credential-routes.js";
import { platformRoutes } from "./platform-routes.js";
import { availableChoices, handleSetup } from "./profile-routes.js";
import {
  evaluationPrefix,
  getEvaluation,
  initialEvaluation,
  listEvaluations,
  saveEvaluation,
} from "./store.js";
import type { EvaluationInput } from "./types.js";

const route =
  /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/evaluations(?:\/(options|profiles|[a-f0-9-]{36}))?(?:\/artifacts)?$/;
const requestSchema = z
  .object({
    id: z.uuid().transform((value) => value.toLowerCase()),
    model: z.string().min(1).max(60),
    harnesses: z
      .array(z.enum(["codex", "claude-code", "pi"]))
      .min(1)
      .max(3),
    sandbox: z.enum(evaluationSandboxes),
    tasks: z
      .array(
        z
          .object({ runId: z.string().min(1).max(100), taskId: z.string().min(1).max(200) })
          .strict(),
      )
      .min(1),
  })
  .strict();
export interface EvaluationRoutesOptions {
  users: UserStore;
  repos: RepoStore;
  tasks: TaskStore;
  artifacts: ArtifactStore;
  publicUrl: string;
  start(input: EvaluationInput): Promise<void>;
  env?: NodeJS.ProcessEnv;
  records?: EncryptedRecordStore;
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
      if (await orgCredentialRoutes(options, request, url, response, user)) return true;
      if (await platformRoutes(options, request, url, response, user)) return true;
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
      if (match[4] === "profiles") {
        await handleSetup(
          request,
          response,
          artifacts,
          {
            repoId: repo.id,
            ownerId: user.githubId,
            tenant: tenant.login,
            publicUrl: options.publicUrl,
          },
          env,
        );
        return true;
      }
      if (request.method === "GET") {
        if (match[4] === "options") {
          const available = (await tasks.listForRepo(repo.id)).filter(
            (task) =>
              task.bundleKey &&
              task.pipelineStatus === "accepted" &&
              task.review?.decision === "approve",
          );
          sendJson(response, 200, {
            ...(await availableChoices(artifacts, repo.id, user.githubId, tenant.login, env)),
            tasks: available.map((task) => ({
              runId: task.runId,
              taskId: task.taskId,
              difficulty: task.difficulty,
            })),
          });
        } else if (match[4]) {
          const run = await getEvaluation(artifacts, repo.id, match[4]);
          if (!run) {
            sendJson(response, 404, { error: "Evaluation not found" });
            return true;
          }
          if (url.pathname.endsWith("/artifacts")) {
            const name = url.searchParams.get("name") ?? "";
            if (!run.trials.some((trial) => trial.artifacts.includes(name))) {
              sendJson(response, 404, { error: "Artifact not found" });
              return true;
            }
            const bytes = await artifacts.getByKey(
              `${evaluationPrefix(repo.id, run.id)}artifacts/${name}`,
            );
            if (!bytes) {
              sendJson(response, 404, { error: "Artifact not found" });
              return true;
            }
            response.writeHead(200, {
              "content-type": "text/plain; charset=utf-8",
              "x-content-type-options": "nosniff",
              "content-disposition": "attachment; filename=solver-artifact.txt",
            });
            response.end(bytes);
          } else sendJson(response, 200, run);
        } else {
          sendJson(response, 200, {
            runs: (await listEvaluations(artifacts, repo.id)).map((run) => ({
              ...run,
              trials: run.trials.map((trial) => ({ ...trial, log: "", steps: [], artifacts: [] })),
            })),
          });
        }
        return true;
      }
      if (request.method !== "POST" || match[4]) {
        sendJson(response, 405, { error: "Method not allowed" });
        return true;
      }
      if (
        request.headers.origin !== new URL(options.publicUrl).origin ||
        !request.headers["content-type"]?.startsWith("application/json")
      ) {
        sendJson(response, 403, { error: "Same-origin JSON request required" });
        return true;
      }
      let body: z.infer<typeof requestSchema>;
      try {
        body = requestSchema.parse(JSON.parse((await readBody(request, 16_384)).toString("utf8")));
      } catch {
        sendJson(response, 400, { error: "Invalid evaluation selection" });
        return true;
      }
      const choices = await availableChoices(artifacts, repo.id, user.githubId, tenant.login, env);
      const model = choices.models.find((candidate) => candidate.id === body.model);
      if (
        !model ||
        (model.sandbox
          ? model.sandbox !== body.sandbox
          : !choices.sandboxes.includes(body.sandbox)) ||
        body.harnesses.some((harness) => !model.harnesses.includes(harness)) ||
        new Set(body.harnesses).size !== body.harnesses.length ||
        new Set(body.tasks.map((task) => `${task.runId}/${task.taskId}`)).size !== body.tasks.length
      ) {
        sendJson(response, 400, {
          error: "Select configured models, harnesses, sandbox and unique tasks",
        });
        return true;
      }
      const selected = await Promise.all(
        body.tasks.map((task) => tasks.find(repo.id, task.runId, task.taskId)),
      );
      if (
        selected.some(
          (task) =>
            !task?.bundleKey ||
            task.pipelineStatus !== "accepted" ||
            task.review?.decision !== "approve",
        )
      ) {
        sendJson(response, 400, {
          error:
            "Every task must belong to this repository and have a human-approved Harbor bundle",
        });
        return true;
      }
      if (
        new Set(selected.map((task) => `${task?.runId}/${task?.taskId}`)).size !== selected.length
      ) {
        sendJson(response, 400, { error: "Select each task only once" });
        return true;
      }
      const existing = await getEvaluation(artifacts, repo.id, body.id);
      if (existing) {
        if (
          existing.model !== body.model ||
          existing.sandbox !== body.sandbox ||
          JSON.stringify(existing.harnesses) !== JSON.stringify(body.harnesses) ||
          JSON.stringify(
            existing.trials.map((trial) => `${trial.runId}/${trial.taskId}/${trial.harness}`),
          ) !==
            JSON.stringify(
              body.tasks.flatMap((task) =>
                body.harnesses.map((harness) => `${task.runId}/${task.taskId}/${harness}`),
              ),
            )
        ) {
          sendJson(response, 409, { error: "This request ID belongs to a different selection" });
          return true;
        }
        if (existing.status === "queued") {
          const saved = await artifacts.getByKey(
            `${evaluationPrefix(repo.id, body.id)}request.json`,
          );
          if (!saved) throw new Error("Evaluation request snapshot is missing");
          await options.start(JSON.parse(Buffer.from(saved).toString("utf8")) as EvaluationInput);
        }
        sendJson(response, 202, existing);
        return true;
      }
      let input: EvaluationInput = {
        ...body,
        modelName: model.model,
        ...(model.id.startsWith("saved-") ? { credentialOwnerId: user.githubId } : {}),
        ...(model.pricing ? { pricing: model.pricing } : {}),
        repoId: repo.id,
        tenant: tenant.login,
        startedBy: user.login,
        createdAt: new Date().toISOString(),
        tasks: selected.map((task) => {
          if (!task?.bundleKey) throw new Error("Task bundle is missing");
          return { runId: task.runId, taskId: task.taskId, bundleKey: task.bundleKey };
        }),
      };
      const requestKey = `${evaluationPrefix(repo.id, body.id)}request.json`;
      const savedRequest = await artifacts.getByKey(requestKey);
      if (savedRequest) {
        const previous = JSON.parse(Buffer.from(savedRequest).toString("utf8")) as EvaluationInput;
        const signature = (value: EvaluationInput) =>
          JSON.stringify({
            model: value.model,
            modelName: value.modelName,
            sandbox: value.sandbox,
            harnesses: value.harnesses,
            tasks: value.tasks.map(({ runId, taskId }) => ({ runId, taskId })),
          });
        if (signature(previous) !== signature(input)) {
          sendJson(response, 409, { error: "This request ID belongs to a different selection" });
          return true;
        }
        input = previous;
      } else {
        await artifacts.put(requestKey, Buffer.from(JSON.stringify(input)), "application/json");
      }
      const run = initialEvaluation(input, model.label);
      await saveEvaluation(artifacts, run);
      await options.start(input);
      sendJson(response, 202, run);
      return true;
    },
  };
}
