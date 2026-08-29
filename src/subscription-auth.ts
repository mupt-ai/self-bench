import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./process.js";

export interface PiModelAuth {
  readonly provider: "openai" | "openai-codex";
  readonly apiKey?: string;
  readonly authJson?: string;
}

export function openAiApiKey(): string | undefined {
  const key = process.env.OPENAI_API_KEY?.trim();
  return key || undefined;
}

export async function loadPiModelAuth(): Promise<PiModelAuth> {
  const apiKey = openAiApiKey();
  return apiKey
    ? { provider: "openai", apiKey }
    : { provider: "openai-codex", authJson: await loadPiSubscriptionAuth() };
}

export async function loadPiSubscriptionAuth(): Promise<string> {
  const raw =
    process.env.SELFBENCH_PI_AUTH_JSON ??
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

export async function githubToken(): Promise<string | undefined> {
  if (process.env.GH_TOKEN) {
    return process.env.GH_TOKEN;
  }
  const result = await runCommand("gh", ["auth", "token"], { allowFailure: true });
  return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
