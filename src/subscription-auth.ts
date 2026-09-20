import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { executionEnvironment } from "./execution-environment.js";
import { runCommand } from "./process.js";

export type PiModelAuthProvider = "openai" | "openai-codex" | "anthropic" | "openrouter";

export interface PiModelAuth {
  readonly provider: PiModelAuthProvider;
  readonly apiKey?: string;
  readonly authJson?: string;
}

function environment(): NodeJS.ProcessEnv {
  return executionEnvironment();
}

/** The env variable Pi reads each provider's API key from inside the sandbox. */
export function piModelAuthKeyName(auth: PiModelAuth): string {
  return auth.provider === "anthropic"
    ? "ANTHROPIC_API_KEY"
    : auth.provider === "openrouter"
      ? "OPENROUTER_API_KEY"
      : "OPENAI_API_KEY";
}

/** The sandbox secrets that authenticate Pi for this resolved provider. */
export function piModelAuthSecrets(auth: PiModelAuth): Record<string, string> {
  if (auth.authJson) return { SELFBENCH_PI_AUTH_JSON: auth.authJson };
  return { [piModelAuthKeyName(auth)]: auth.apiKey ?? "" };
}

/**
 * Resolves the credentials a sandbox's Pi invocation should authenticate with. Generation
 * runs place exactly one provider credential in the environment, so the key variables are
 * checked in a fixed order; without any of them, the host's ChatGPT subscription applies.
 */
export async function loadPiModelAuth(): Promise<PiModelAuth> {
  const env = environment();
  const openAi = env.OPENAI_API_KEY?.trim();
  if (openAi) return { provider: "openai", apiKey: openAi };
  const anthropic = env.ANTHROPIC_API_KEY?.trim();
  if (anthropic) return { provider: "anthropic", apiKey: anthropic };
  const openRouter = env.OPENROUTER_API_KEY?.trim();
  if (openRouter) return { provider: "openrouter", apiKey: openRouter };
  return { provider: "openai-codex", authJson: await loadPiSubscriptionAuth() };
}

export async function loadPiSubscriptionAuth(): Promise<string> {
  const raw =
    environment().SELFBENCH_PI_AUTH_JSON ??
    (await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8"));
  const parsed = JSON.parse(raw) as unknown;
  const credential = isRecord(parsed) ? parsed["openai-codex"] : undefined;
  if (
    !isRecord(credential) ||
    credential.type !== "oauth" ||
    typeof credential.access !== "string" ||
    typeof credential.refresh !== "string"
  ) {
    throw new Error("Pi auth does not contain an openai-codex subscription credential");
  }
  return JSON.stringify({ "openai-codex": credential });
}

export async function githubToken(signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  const token = executionEnvironment().GH_TOKEN;
  if (token) {
    return token;
  }
  const result = await runCommand("gh", ["auth", "token"], {
    allowFailure: true,
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
