import type { CredentialInfo } from "../../../../src/db/credentials";

export const providers = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "openrouter", label: "OpenRouter" },
  { id: "custom", label: "Custom Endpoint" },
] as const;
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
    : credential.kind === "modal"
      ? "Token Pair"
      : "API Key";
}
