import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { User } from "../../db/users.js";
import {
  explanationModel,
  explanationSelectionSchema,
} from "../../evaluation/explanation-model.js";
import {
  readModelSummaries,
  type SummaryTask,
  summarizable,
} from "../../evaluation/model-summary.js";
import type { EvaluationScope } from "../../evaluation/scope.js";
import { listEvaluations } from "../../evaluation/store.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import type { EvaluationRoutesOptions } from "./evaluations.js";

const UNAVAILABLE = "Model summaries are unavailable on this deployment.";
const BUSY = "Summaries are already being written here. Try again once they finish.";
/** The most configurations one request summarizes: each is a model call on the chosen key. */
const MAX_CONFIGURATIONS = 20;

const requestSchema = z.strictObject({
  configurations: z.array(z.string().min(1).max(1_000)).min(1).max(MAX_CONFIGURATIONS),
  summary: explanationSelectionSchema,
});

type Options = Pick<EvaluationRoutesOptions, "artifacts" | "vault" | "publicUrl" | "summarize">;
interface Context {
  /** The repository's or benchmark's evaluations, and the org that owns them. */
  scope: EvaluationScope;
  orgId: number;
  user: User;
  env: NodeJS.ProcessEnv;
  /** The tasks results count on: the repository's accepted tasks, or the benchmark's. */
  tasks(): Promise<SummaryTask[]>;
}

/**
 * `…/evaluations/summaries` (Model Summaries in the app). GET gives the scope's summaries, why the
 * latest of any gave none, and which configurations are being summarized; POST summarizes the
 * configurations it names through a saved key and model, which is explicit consent to send their
 * results there.
 */
export async function modelSummariesRoute(
  options: Options,
  request: IncomingMessage,
  response: ServerResponse,
  { scope, orgId, user, env, tasks }: Context,
): Promise<void> {
  if (request.method === "GET") {
    const [{ summaries, failures }, running] = await Promise.all([
      readModelSummaries(options.artifacts, scope),
      options.summarize ? options.summarize.running(scope) : [],
    ]);
    sendJson(response, 200, {
      available: !!options.summarize,
      ...(options.summarize ? {} : { reason: UNAVAILABLE }),
      running,
      summaries,
      failures,
    });
    return;
  }
  if (!trustedMutation(request, options.publicUrl, user)) {
    sendJson(response, 403, { error: "Same-origin JSON request required" });
    return;
  }
  let asked: z.infer<typeof requestSchema>;
  try {
    asked = requestSchema.parse(JSON.parse((await readBody(request, 64_000)).toString()));
  } catch {
    sendJson(response, 400, {
      error: `Choose up to ${MAX_CONFIGURATIONS} configurations and a model.`,
    });
    return;
  }
  if (!options.summarize) {
    sendJson(response, 409, { error: UNAVAILABLE });
    return;
  }
  if ((await options.summarize.running(scope)).length) {
    sendJson(response, 409, { error: BUSY });
    return;
  }
  const credential = await options.vault?.credentials.find(orgId, asked.summary.credentialId);
  try {
    if (!credential) throw new Error("The selected model API key is unavailable.");
    explanationModel(credential, asked.summary.model, env);
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : "Invalid summary model.",
    });
    return;
  }
  const [runs, counted] = await Promise.all([listEvaluations(options.artifacts, scope), tasks()]);
  const settings = summarizable(runs, counted);
  const configurations = [...new Set(asked.configurations)].filter((key) => settings.has(key));
  if (!configurations.length) {
    sendJson(response, 409, {
      error: "None of the chosen configurations has a scored result on the accepted tasks.",
    });
    return;
  }
  const started = await options.summarize.start({
    ...scope,
    configurations,
    tasks: counted,
    summary: { ...asked.summary, orgId },
  });
  // Another request started first: its configurations, not these, are being summarized.
  if (!started) sendJson(response, 409, { error: BUSY });
  else sendJson(response, 202, { configurations });
}
