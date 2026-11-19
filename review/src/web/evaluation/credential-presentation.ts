import type { CredentialInfo } from "../../../../src/db/credentials";
import { gatewayIds, gateways } from "../../../../src/gateways/index";

export const providers = [
  { id: "dari", label: "Dari" },
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "meta", label: "Meta" },
  ...gatewayIds.map((id) => ({ id, label: gateways[id].label })),
  { id: "custom", label: "Custom Endpoint" },
  { id: "dari-link", label: "Dari Link" },
] as const;
/**
 * The provider sign-ins SelfBench took before Connect with Dari, by the label past runs and saved
 * credentials still show. Nothing new is made with them.
 */
export const signIns = [
  { id: "codex-login", label: "ChatGPT Sign-In", harness: "Codex" },
  { id: "claude-login", label: "Claude Sign-In", harness: "Claude Code" },
  { id: "muse-login", label: "Meta Sign-In", harness: "Muse Code" },
] as const;
const signInOf = (auth: CredentialInfo["auth"]) => signIns.find((entry) => entry.id === auth);
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
  if (credential.auth === "dari-link") return "Dari";
  return (
    signInOf(credential.auth)?.harness ??
    [...providers, ...sandboxes].find((entry) => entry.id === credential.kind)?.label ??
    credential.kind
  );
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
  if (credential.auth === "dari-link") return "Connected via Dari";
  return (
    signInOf(credential.auth)?.label ?? (credential.kind === "modal" ? "Token Pair" : "API Key")
  );
}
