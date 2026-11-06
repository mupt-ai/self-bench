import { readFile } from "node:fs/promises";
import { requestJson } from "./api-client.js";
import { flag, type Values } from "./args.js";

/** How a generation runs; omitted flags take the app's defaults (managed models and sandbox). */
export const GENERATION = {
  model: { type: "string" },
  "verifier-model": { type: "string" },
  reasoning: { type: "string" },
  "model-credential": { type: "string" },
  sandbox: { type: "string" },
  "sandbox-credential": { type: "string" },
  harbor: { type: "string" },
  "harbor-credential": { type: "string" },
  generation: { type: "string" },
} as const;

/**
 * `{generation}` from `--generation JSON` or `--generation @FILE`, else from the flags. A
 * deployment that stores no credentials takes no settings, which generation-options says.
 */
export async function generation(
  values: Values,
  repository: string,
): Promise<{ generation?: Record<string, unknown> }> {
  const given = flag(values, "generation");
  if (given !== undefined) {
    const text = given.startsWith("@") ? await readFile(given.slice(1), "utf8") : given;
    return { generation: JSON.parse(text) as Record<string, unknown> };
  }
  const offered = await requestJson(`${repository}/generation-options`);
  return offered.available === false ? {} : { generation: generationFromFlags(values) };
}

/** The settings the flags describe; omitted ones take the app's defaults. */
export function generationFromFlags(values: Values): Record<string, unknown> {
  const model = flag(values, "model") ?? "gpt-6.1-sol";
  const modelCredential = flag(values, "model-credential");
  const optional = {
    sandboxCredentialId: flag(values, "sandbox-credential"),
    harborEnvironment: flag(values, "harbor"),
    harborCredentialId: flag(values, "harbor-credential"),
  };
  return {
    authorModel: model,
    verifierModel: flag(values, "verifier-model") ?? model,
    reasoning: flag(values, "reasoning") ?? "high",
    modelAccess: modelCredential ? "credential" : "managed",
    ...(modelCredential ? { modelCredentialId: modelCredential } : {}),
    sandbox: flag(values, "sandbox") ?? "managed",
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  };
}
