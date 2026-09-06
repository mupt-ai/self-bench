import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson } from "../api/http.js";
import type { ArtifactStore } from "../artifacts.js";
import { evaluationChoices } from "./config.js";
import { type EvaluationSetup, listSetups, saveSetup, setupSchema } from "./profiles.js";

export async function availableChoices(
  store: ArtifactStore,
  repoId: number,
  ownerId: number,
  tenant: string,
  env: NodeJS.ProcessEnv,
) {
  const configured = evaluationChoices(tenant, env);
  const saved = await listSetups(store, repoId, ownerId, env);
  const configurable = /^[a-f0-9]{64}$/.test(env.SELFBENCH_EVAL_CREDENTIAL_KEY ?? "");
  return {
    ...configured,
    configurable,
    models: [...configured.models, ...saved],
    sandboxes: configured.sandboxes,
  };
}
export async function handleSetup(
  request: IncomingMessage,
  response: ServerResponse,
  store: ArtifactStore,
  scope: { repoId: number; ownerId: number; tenant: string; publicUrl: string },
  env: NodeJS.ProcessEnv,
) {
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  if (
    request.headers.origin !== new URL(scope.publicUrl).origin ||
    !request.headers["content-type"]?.startsWith("application/json")
  ) {
    sendJson(response, 403, { error: "Same-origin JSON request required" });
    return;
  }
  if (!/^[a-f0-9]{64}$/.test(env.SELFBENCH_EVAL_CREDENTIAL_KEY ?? "")) {
    sendJson(response, 503, { error: "Secure credential storage is temporarily unavailable" });
    return;
  }
  let setup: EvaluationSetup;
  try {
    setup = setupSchema.parse(JSON.parse((await readBody(request, 20_000)).toString("utf8")));
  } catch {
    sendJson(response, 400, {
      error: "Enter a model ID and the required model and sandbox credentials",
    });
    return;
  }
  try {
    sendJson(
      response,
      201,
      await saveSetup(store, scope.repoId, scope.ownerId, scope.tenant, setup, env),
    );
  } catch {
    sendJson(response, 503, {
      error: "Could not save configuration securely. No evaluation started.",
    });
  }
}
