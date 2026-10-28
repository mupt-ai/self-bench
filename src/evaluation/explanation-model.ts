import { z } from "zod";
import { validateEndpoint } from "../db/credential-endpoints.js";
import type { CredentialInfo } from "../db/credentials.js";
import { generationModel, piModelsFiles } from "../generation/settings/models.js";
import { defaultThinking, routeFor, thinkingOptions } from "./models.js";

export const explanationSelectionSchema = z.strictObject({
  credentialId: z.uuid(),
  model: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/),
});

/** Only API keys, never sandbox credentials or subscription sign-ins, fund an explanation. */
export function explanationModel(credential: CredentialInfo, id: string, env: NodeJS.ProcessEnv) {
  if (credential.auth !== "api-key") throw new Error("Choose a model API key, not a sign-in.");
  if (credential.kind === "custom") {
    return {
      provider: "custom",
      model: id,
      summaryModel: id,
      thinking: "default",
      models: JSON.stringify({
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: validateEndpoint(credential.endpoint ?? "", env),
            apiKey: "$OPENAI_API_KEY",
            models: [modelDefinition(id, id, false)],
          },
        },
      }),
    };
  }
  const catalog = generationModel(id);
  const route = catalog && routeFor(catalog, credential.kind);
  if (!route?.harnesses.includes("pi"))
    throw new Error("This model cannot run on the selected API key.");
  const files = piModelsFiles(route.provider, route.model);
  return {
    provider: route.provider,
    model: route.model,
    summaryModel: id,
    thinking: defaultThinking(thinkingOptions(route, ["pi"])),
    models:
      files?.models ??
      JSON.stringify({
        providers: {
          [route.provider]: {
            models: [modelDefinition(route.model, route.label, !!route.thinking?.length)],
          },
        },
      }),
  };
}

function modelDefinition(id: string, name: string, reasoning: boolean) {
  return {
    id,
    name,
    reasoning,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
