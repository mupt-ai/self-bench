import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ConnectedRepo } from "../../db/repos.js";
import type { User } from "../../db/users.js";
import {
  explanationModel,
  explanationSelectionSchema,
} from "../../evaluation/explanation-model.js";
import { listEvaluations } from "../../evaluation/store.js";
import { failedAttempt, readTaskAudit, taskAttempts } from "../../evaluation/task-audit.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";
import { trialTaskFiles } from "./trial-task.js";

const taskSchema = z.object({ runId: z.string().min(1), taskId: z.string().min(1) }).strict();

type Options = Pick<EvaluationRoutesOptions, "artifacts" | "vault" | "publicUrl" | "audit">;
interface Context {
  repo: ConnectedRepo;
  user: User;
  env: NodeJS.ProcessEnv;
}

/**
 * `…/evaluations/audit`, for one task named by its batch and id (Audit Task in the app). GET tells
 * how many attempts failed it, whether an audit is running, and the last audit; POST starts one
 * through a saved key and model, which is explicit consent to send the task's failures there.
 */
export async function auditTaskRoute(
  options: Options,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
  { repo, user, env }: Context,
): Promise<void> {
  if (request.method === "POST" && !trustedMutation(request, options.publicUrl, user)) {
    sendJson(response, 403, { error: "Same-origin JSON request required" });
    return;
  }
  let task: z.infer<typeof taskSchema>;
  let selection: z.infer<typeof explanationSelectionSchema> | undefined;
  try {
    if (request.method === "POST") {
      const { audit, ...named } = taskSchema
        .extend({ audit: explanationSelectionSchema })
        .parse(JSON.parse((await readBody(request, 4_096)).toString()));
      task = named;
      selection = audit;
    } else task = taskSchema.parse(Object.fromEntries(url.searchParams));
  } catch {
    sendJson(response, 400, {
      error: "Name the task by its runId and taskId, and choose a model.",
    });
    return;
  }
  const ref = { repoId: repo.id, ...task };
  const attempts = taskAttempts(
    await listEvaluations(options.artifacts, { repoId: repo.id }),
    task,
  );
  const failures = attempts.filter(failedAttempt);
  const { audit, failure } = await readTaskAudit(options.artifacts, ref);
  const running = options.audit ? (await options.audit.state(ref)).running : false;
  const reason = !options.audit
    ? "Task audits are unavailable on this deployment."
    : !failures.length
      ? "No attempt failed this task, so there is nothing to audit."
      : undefined;
  if (request.method === "GET") {
    sendJson(response, 200, {
      available: !reason,
      running,
      attempts: attempts.length,
      failures: failures.length,
      ...(reason ? { reason } : {}),
      ...(audit ? { audit } : {}),
      ...(failure ? { failure } : {}),
    });
    return;
  }
  if (reason || !options.audit || !selection) {
    sendJson(response, 409, { error: reason ?? "Task audits are unavailable." });
    return;
  }
  if (running) {
    sendJson(response, 202, {});
    return;
  }
  let files: Awaited<ReturnType<typeof trialTaskFiles>>;
  for (const { run, index } of attempts) {
    files = await trialTaskFiles(options.artifacts, options.vault, repo, run, index);
    if (files) break;
  }
  if (!files) {
    sendJson(response, 409, {
      error: "This task's files were not recorded, so it can't be audited.",
    });
    return;
  }
  const credential = await options.vault?.credentials.find(repo.orgId, selection.credentialId);
  try {
    if (!credential) throw new Error("The selected model API key is unavailable.");
    explanationModel(credential, selection.model, env);
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Invalid audit model.",
    });
    return;
  }
  await options.audit.start({ ...ref, ...files, audit: { ...selection, orgId: repo.orgId } });
  sendJson(response, 202, {});
}
