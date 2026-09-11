import { z } from "zod";
import { harnessIds } from "./harnesses.js";
import { modelIdPattern, modelProvider, providers } from "./providers.js";
import type { EvaluationChoices, EvaluationInput } from "./types.js";

export const HARBOR_VERSION = "0.20.1.dev202608040148";
export const evaluationSandboxes = ["docker", "modal", "e2b", "daytona"] as const;
const profileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    label: z.string().min(1).max(100),
    model: z
      .string()
      .refine(
        (value) =>
          !!modelProvider(value) &&
          modelIdPattern.test(value.slice(value.indexOf("/") + 1)) &&
          value.includes("/"),
      ),
    harnesses: z.array(z.enum(harnessIds)).min(1).max(harnessIds.length),
    tenants: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).min(1),
    credentialEnv: z.string().regex(/^SELFBENCH_EVAL_SECRET_[A-Z0-9_]+$/),
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
  .superRefine((profile, context) => {
    if (profile.harnesses.includes("codex") && !profile.model.startsWith("openai/")) {
      context.addIssue({ code: "custom", message: "Codex requires an OpenAI model" });
    }
    if (profile.harnesses.includes("claude-code") && !profile.model.startsWith("anthropic/")) {
      context.addIssue({ code: "custom", message: "Claude Code requires an Anthropic model" });
    }
  });
export function evaluationConfig(env: NodeJS.ProcessEnv = process.env) {
  const profiles = z
    .array(profileSchema)
    .max(50)
    .parse(JSON.parse(env.SELFBENCH_EVAL_MODELS ?? "[]"));
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new Error("Duplicate evaluation model IDs");
  }
  const sandboxes = z
    .array(z.enum(evaluationSandboxes))
    .max(4)
    .parse(JSON.parse(env.SELFBENCH_EVAL_SANDBOXES ?? "[]"));
  return { profiles, sandboxes };
}
export function evaluationChoices(
  tenant: string,
  env: NodeJS.ProcessEnv = process.env,
): EvaluationChoices {
  const config = evaluationConfig(env);
  return {
    harborVersion: HARBOR_VERSION,
    sandboxes: [...new Set(config.sandboxes)],
    models: config.profiles
      .filter((profile) =>
        profile.tenants.some((allowed) => allowed.toLowerCase() === tenant.toLowerCase()),
      )
      .map(({ id, label, model, harnesses, pricing }) => ({
        id,
        label,
        model,
        harnesses: [...new Set(harnesses)],
        ...(pricing ? { pricing } : {}),
      })),
  };
}
export function solverEnvironment(
  input: EvaluationInput,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const config = evaluationConfig(env);
  const profile = config.profiles.find(
    (candidate) =>
      candidate.id === input.model &&
      candidate.tenants.some((tenant) => tenant.toLowerCase() === input.tenant.toLowerCase()),
  );
  if (
    !profile ||
    profile.model !== input.modelName ||
    !config.sandboxes.includes(input.sandbox) ||
    input.harnesses.some((harness) => !profile.harnesses.includes(harness))
  ) {
    throw new Error("Evaluation configuration is no longer available");
  }
  const secret = env[profile.credentialEnv];
  if (!secret) throw new Error("Evaluation model credential is not configured on the worker");
  const child: NodeJS.ProcessEnv = {
    PATH: env.PATH,
    HOME: home,
    TMPDIR: home,
    LANG: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
  };
  const provider = modelProvider(profile.model);
  if (!provider) throw new Error("Unsupported model provider");
  child[providers[provider].credential] = secret;
  if (input.sandbox === "docker" && env.DOCKER_HOST) child.DOCKER_HOST = env.DOCKER_HOST;
  if (input.sandbox === "modal") {
    if (
      !env.SELFBENCH_EVAL_SECRET_MODAL_TOKEN_ID ||
      !env.SELFBENCH_EVAL_SECRET_MODAL_TOKEN_SECRET
    ) {
      throw new Error("Evaluation Modal credentials are not configured on the worker");
    }
    child.MODAL_TOKEN_ID = env.SELFBENCH_EVAL_SECRET_MODAL_TOKEN_ID;
    child.MODAL_TOKEN_SECRET = env.SELFBENCH_EVAL_SECRET_MODAL_TOKEN_SECRET;
  }
  for (const [sandbox, name] of [
    ["e2b", "E2B_API_KEY"],
    ["daytona", "DAYTONA_API_KEY"],
  ] as const) {
    if (input.sandbox !== sandbox) continue;
    const value = env[`SELFBENCH_EVAL_SECRET_${name}`];
    if (!value) throw new Error(`Evaluation ${sandbox} API key is missing`);
    child[name] = value;
  }
  return { profile, child };
}
