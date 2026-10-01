import type { CredentialInfo } from "../../../../src/db/credentials";
import { gatewayIds, gateways } from "../../../../src/gateways/index";

export const providers = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  ...gatewayIds.map((id) => ({ id, label: gateways[id].label })),
  { id: "custom", label: "Custom Endpoint" },
] as const;
/** The subscription sign-in a model provider offers beside its API key, and the CLI it runs. */
export const signIns = [
  {
    id: "codex-login",
    kind: "openai",
    label: "ChatGPT Sign-In",
    harness: "Codex",
    name: "Codex",
    importLabel: "Import auth.json",
  },
  {
    id: "claude-login",
    kind: "anthropic",
    label: "Claude Sign-In",
    harness: "Claude Code",
    name: "Claude",
    importLabel: "Paste a Setup Token",
  },
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
  return (
    signInOf(credential.auth)?.label ?? (credential.kind === "modal" ? "Token Pair" : "API Key")
  );
}
