import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ArtifactStore } from "../artifacts.js";
import { createSecretBox } from "../auth/crypto.js";
import { evaluationSandboxes } from "./config.js";
import { modelIdPattern, providerIds, providers } from "./providers.js";
import type { EvaluationInput, EvaluationModel } from "./types.js";

const secret = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[^\r\n\0]+$/);
export const setupSchema = z
  .object({
    provider: z.enum(providerIds),
    model: z.string().trim().regex(modelIdPattern),
    modelApiKey: secret,
    sandbox: z.enum(evaluationSandboxes),
    sandboxApiKey: secret.optional(),
    modalTokenId: secret.optional(),
    modalTokenSecret: secret.optional(),
    pricing: z
      .object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        cacheRead: z.number().nonnegative(),
        cacheWrite: z.number().nonnegative(),
        source: z.url(),
        asOf: z.iso.date(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((setup, context) => {
    if ((setup.sandbox === "e2b" || setup.sandbox === "daytona") && !setup.sandboxApiKey)
      context.addIssue({ code: "custom", message: "Sandbox API key is required" });
    if (setup.sandbox === "modal" && (!setup.modalTokenId || !setup.modalTokenSecret))
      context.addIssue({ code: "custom", message: "Modal token ID and secret are required" });
    if (setup.sandbox !== "modal" && (setup.modalTokenId || setup.modalTokenSecret))
      context.addIssue({ code: "custom", message: "Unexpected Modal credentials" });
    if (!["e2b", "daytona"].includes(setup.sandbox) && setup.sandboxApiKey)
      context.addIssue({ code: "custom", message: "Unexpected sandbox API key" });
  });
export type EvaluationSetup = z.infer<typeof setupSchema>;
interface SavedSetup extends EvaluationSetup {
  id: string;
  repoId: number;
  ownerId: number;
  tenant: string;
}
function profilePrefix(repoId: number, ownerId: number) {
  if (![repoId, ownerId].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new Error("Invalid credential scope");
  return `private/evaluation-profiles/repos/${repoId}/users/${ownerId}/`;
}
function box(env: NodeJS.ProcessEnv) {
  const key = env.SELFBENCH_EVAL_CREDENTIAL_KEY;
  if (!key || !/^[a-f0-9]{64}$/.test(key)) throw new Error("Credential encryption is unavailable");
  return createSecretBox(Buffer.from(key, "hex"));
}
export function publicSetup(setup: SavedSetup): EvaluationModel {
  return {
    id: setup.id,
    label: `${setup.model} · ${setup.sandbox}`.slice(0, 100),
    model: `${setup.provider}/${setup.model}`,
    harnesses: providers[setup.provider].harnesses,
    sandbox: setup.sandbox,
    ...(setup.pricing ? { pricing: setup.pricing } : {}),
  };
}
export async function saveSetup(
  store: ArtifactStore,
  repoId: number,
  ownerId: number,
  tenant: string,
  setup: EvaluationSetup,
  env: NodeJS.ProcessEnv,
) {
  const saved: SavedSetup = {
    ...setupSchema.parse(setup),
    id: `saved-${randomUUID()}`,
    repoId,
    ownerId,
    tenant,
  };
  await store.put(
    `${profilePrefix(repoId, ownerId)}${saved.id}.bin`,
    box(env).seal(JSON.stringify(saved)),
    "application/octet-stream",
  );
  return publicSetup(saved);
}
export async function readSetup(
  store: ArtifactStore,
  repoId: number,
  ownerId: number,
  id: string,
  env: NodeJS.ProcessEnv,
): Promise<SavedSetup | undefined> {
  if (!/^saved-[a-f0-9-]{36}$/.test(id)) return undefined;
  const bytes = await store.getByKey(`${profilePrefix(repoId, ownerId)}${id}.bin`);
  if (!bytes) return undefined;
  const saved = JSON.parse(box(env).open(bytes)) as SavedSetup;
  if (saved.repoId !== repoId || saved.ownerId !== ownerId || saved.id !== id)
    throw new Error("Credential scope mismatch");
  setupSchema.parse({
    provider: saved.provider,
    model: saved.model,
    modelApiKey: saved.modelApiKey,
    sandbox: saved.sandbox,
    sandboxApiKey: saved.sandboxApiKey,
    modalTokenId: saved.modalTokenId,
    modalTokenSecret: saved.modalTokenSecret,
    pricing: saved.pricing,
  });
  return saved;
}
export async function listSetups(
  store: ArtifactStore,
  repoId: number,
  ownerId: number,
  env: NodeJS.ProcessEnv,
) {
  if (!env.SELFBENCH_EVAL_CREDENTIAL_KEY) return [];
  const prefix = profilePrefix(repoId, ownerId);
  const entries = (await store.list(prefix.slice(0, -1))).filter(
    (entry) => entry.key.startsWith(prefix) && entry.key.endsWith(".bin"),
  );
  const profiles = await Promise.all(
    entries.map((entry) =>
      readSetup(store, repoId, ownerId, entry.key.slice(prefix.length, -4), env),
    ),
  );
  return profiles.filter((profile): profile is SavedSetup => !!profile).map(publicSetup);
}
export async function profileEnvironment(
  store: ArtifactStore,
  input: EvaluationInput,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  if (!input.model.startsWith("saved-")) return env;
  if (!input.credentialOwnerId) throw new Error("Credential owner is missing");
  const setup = await readSetup(store, input.repoId, input.credentialOwnerId, input.model, env);
  if (
    !setup ||
    setup.tenant !== input.tenant ||
    setup.sandbox !== input.sandbox ||
    `${setup.provider}/${setup.model}` !== input.modelName
  )
    throw new Error("Saved configuration is unavailable for this run");
  return {
    ...env,
    SELFBENCH_EVAL_MODELS: JSON.stringify([
      {
        ...publicSetup(setup),
        tenants: [input.tenant],
        credentialEnv: "SELFBENCH_EVAL_SECRET_SAVED",
        sandbox: undefined,
      },
    ]),
    SELFBENCH_EVAL_SANDBOXES: JSON.stringify([setup.sandbox]),
    SELFBENCH_EVAL_SECRET_SAVED: setup.modelApiKey,
    SELFBENCH_EVAL_SECRET_MODAL_TOKEN_ID: setup.modalTokenId,
    SELFBENCH_EVAL_SECRET_MODAL_TOKEN_SECRET: setup.modalTokenSecret,
    SELFBENCH_EVAL_SECRET_E2B_API_KEY: setup.sandbox === "e2b" ? setup.sandboxApiKey : undefined,
    SELFBENCH_EVAL_SECRET_DAYTONA_API_KEY:
      setup.sandbox === "daytona" ? setup.sandboxApiKey : undefined,
  };
}
