import type { CredentialInfo } from "../../../../src/db/credentials";

export const providers = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "custom", label: "Custom Endpoint" },
] as const;
/** The subscription sign-in each model provider offers beside its API key. */
export const signIns: Partial<
  Record<CredentialInfo["kind"], { id: CredentialInfo["auth"]; label: string }>
> = {
  openai: { id: "codex-login", label: "ChatGPT Sign-In" },
  anthropic: { id: "claude-login", label: "Claude Sign-In" },
};
export const sandboxes = [
  { id: "e2b", label: "E2B" },
  { id: "modal", label: "Modal" },
  { id: "daytona", label: "Daytona" },
  { id: "vercel", label: "Vercel" },
] as const;
export function isSandbox(kind: CredentialInfo["kind"]) {
  return sandboxes.some((entry) => entry.id === kind);
}
export function credentialProvider(credential: Pick<CredentialInfo, "kind" | "auth">) {
  return credential.auth === "codex-login"
    ? "Codex"
    : credential.auth === "claude-login"
      ? "Claude Code"
      : ([...providers, ...sandboxes].find((entry) => entry.id === credential.kind)?.label ??
        credential.kind);
}
/**
 * A custom endpoint as a maintainer tells two apart: host, port and path, without the scheme or a
 * trailing slash. Two endpoints can share a hostname and differ only by port or path.
 */
export function endpointLabel(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.host}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return endpoint;
  }
}
export function credentialAccess(credential: Pick<CredentialInfo, "kind" | "auth">) {
  return credential.auth === "codex-login"
    ? "ChatGPT Sign-In"
    : credential.auth === "claude-login"
      ? "Claude Sign-In"
      : credential.kind === "modal"
        ? "Token Pair"
        : "API Key";
}
