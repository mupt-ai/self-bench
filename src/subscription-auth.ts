import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./process.js";

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

export function assertCodexSubscriptionAuth(value: unknown, source = "Codex auth"): void {
  if (!isRecord(value) || value.auth_mode !== "chatgpt" || !isRecord(value.tokens)) {
    throw new Error(`${source} does not contain a ChatGPT subscription token set`);
  }
}

export async function loadCodexSubscriptionAuth(): Promise<string> {
  const path = process.env.CODEX_AUTH_JSON_PATH ?? join(homedir(), ".codex/auth.json");
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  assertCodexSubscriptionAuth(parsed, path);
  const auth = parsed as Record<string, unknown>;
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: auth.tokens,
    ...(typeof auth.last_refresh === "string" ? { last_refresh: auth.last_refresh } : {}),
  });
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
