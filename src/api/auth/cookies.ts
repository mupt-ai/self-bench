import type { IncomingMessage, ServerResponse } from "node:http";

export interface CookieOptions {
  readonly maxAgeSeconds: number;
  readonly secure: boolean;
  readonly path?: string;
}

export function parseCookies(request: IncomingMessage): Record<string, string> {
  const header = request.headers.cookie;
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // a malformed cookie is treated as absent
    }
  }
  return cookies;
}

/** Appends a Set-Cookie header; HttpOnly and SameSite=Lax always, Secure per the public URL. */
export function setCookie(
  response: ServerResponse,
  name: string,
  value: string,
  options: CookieOptions,
): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? "/"}`,
    `Max-Age=${options.maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (options.secure) parts.push("Secure");
  const existing = response.getHeader("set-cookie");
  const list = Array.isArray(existing) ? existing : typeof existing === "string" ? [existing] : [];
  response.setHeader("set-cookie", [...list, parts.join("; ")]);
}

export function clearCookie(
  response: ServerResponse,
  name: string,
  options: Omit<CookieOptions, "maxAgeSeconds">,
): void {
  setCookie(response, name, "", { ...options, maxAgeSeconds: 0 });
}

export function sendRedirect(response: ServerResponse, location: string): void {
  response.writeHead(302, { location, "cache-control": "no-store" });
  response.end();
}
