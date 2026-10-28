import type { CredentialDraft } from "./credentials.js";

/** Dari's routing host; a credential may name one of its routers instead of the default. */
const DARI_HOST = "https://routing.dari.dev";

/**
 * The Dari base URL a credential runs against: its default router (`/v1`) when the credential
 * names none, else the router it names, as `/rtr_…`. A URL copied from a request address keeps
 * only its router, since the harness appends the API method itself.
 */
export function dariEndpoint(endpoint?: string): string {
  const base = `${DARI_HOST}/v1`;
  if (!endpoint) return base;
  const url = new URL(endpoint);
  const path = url.pathname
    .replace(/\/(chat\/completions|completions|responses)$/, "")
    .replace(/\/+$/, "");
  if (
    `${url.protocol}//${url.host}` !== DARI_HOST ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("A Dari router URL must be on routing.dari.dev");
  if (path === "" || path === "/v1") return base;
  const router = path.slice(1);
  if (router.includes("/") || !/^[A-Za-z0-9_-]+$/.test(router))
    throw new Error("Use routing.dari.dev/<router_id>, without an API method");
  return `${DARI_HOST}/${router}`;
}

export function validateEndpoint(endpoint: string, env: NodeJS.ProcessEnv): string {
  const url = new URL(endpoint);
  const allowed = (env.SELFBENCH_CUSTOM_MODEL_HOSTS ?? "").split(",").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !allowed.includes(url.hostname) ||
    (url.port && url.port !== "443")
  )
    throw new Error("Custom endpoint must use HTTPS on an operator-approved hostname");
  return url.toString().replace(/\/$/, "");
}

/**
 * The endpoint a credential is saved with, as its kind reads it: a Dari credential's router, or a
 * custom endpoint on an operator-approved host. Other kinds keep none.
 */
export function credentialEndpoint(
  parsed: Pick<CredentialDraft, "kind" | "endpoint">,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (parsed.kind === "dari") return parsed.endpoint ? dariEndpoint(parsed.endpoint) : undefined;
  return parsed.endpoint ? validateEndpoint(parsed.endpoint, env) : undefined;
}
