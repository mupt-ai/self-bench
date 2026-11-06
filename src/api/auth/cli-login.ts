import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ApiKeyStore } from "../../db/api-keys.js";
import type { User, UserStore } from "../../db/users.js";
import { readBody, sendJson } from "../http.js";
import type { AuthConfig } from "./config.js";
import { sendRedirect } from "./cookies.js";
import { constantTimeEqual, deriveKey, hmacSign } from "./crypto.js";

/** How long the browser's code may wait for the CLI to exchange it. */
const CODE_TTL_MS = 5 * 60_000;

/** What `/auth/cli` takes: where the CLI listens, its state, its PKCE challenge, and its host. */
const requestSchema = z.strictObject({
  callback: z.url(),
  state: z.string().min(16).max(256),
  challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  name: z.string().trim().min(1).max(60).default("terminal"),
});
type CliRequest = z.infer<typeof requestSchema>;

const tokenSchema = z.strictObject({
  code: z.string().min(1).max(2048),
  verifier: z.string().min(43).max(128),
});

/** Only a CLI on the signing-in person's own machine may receive the code. */
function loopback(callback: string): boolean {
  const url = new URL(callback);
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export interface CliLoginOptions {
  readonly config: AuthConfig;
  readonly users: UserStore;
  readonly apiKeys?: ApiKeyStore;
  /** The browser session's user, or undefined when nobody is signed in. */
  readonly sessionUser: (request: IncomingMessage) => Promise<User | undefined>;
  readonly now: () => Date;
}

/**
 * The CLI's browser sign-in (`self-bench login`), as an OAuth authorization-code flow with PKCE:
 * GET /auth/cli asks the signed-in person to approve, POST /auth/cli redirects to the CLI's
 * loopback callback with a signed code, and POST /auth/cli/token exchanges the code and the PKCE
 * verifier for a new personal write key. Codes are stateless, signed, and expire in five minutes;
 * only the CLI that holds the verifier can exchange one.
 */
export function createCliLogin(options: CliLoginOptions) {
  const key = deriveKey(options.config.sessionSecret, "cli-login");
  const sign = (payload: string) => `${payload}.${hmacSign(key, payload)}`;
  const opened = (code: string) => {
    const at = code.lastIndexOf(".");
    const payload = code.slice(0, at);
    if (at < 1 || !constantTimeEqual(hmacSign(key, payload), code.slice(at + 1))) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      /** The GitHub id of the person who approved. */
      user: number;
      challenge: string;
      name: string;
      expires: number;
    };
    return claims.expires > options.now().getTime() ? claims : undefined;
  };

  const parsed = (params: URLSearchParams): CliRequest | undefined => {
    const found = requestSchema.safeParse(Object.fromEntries(params));
    return found.success && loopback(found.data.callback) ? found.data : undefined;
  };

  const approve = (response: ServerResponse, request: CliRequest, user: User) => {
    const hidden = Object.entries(request)
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
      .join("");
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-frame-options": "DENY",
    });
    response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Authorize the SelfBench CLI</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:28rem;margin:15vh auto;padding:0 16px;color:#222}
button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#0f9d76;color:#fff;cursor:pointer}
code{background:#f2f2f2;padding:0 .3em;border-radius:3px}</style>
<h1>Authorize the SelfBench CLI</h1>
<p>Signed in as <b>${escapeHtml(user.login)}</b>. The CLI on <code>${escapeHtml(request.name)}</code> will get a personal API key that can do whatever you can in your workspaces.</p>
<p>Only continue if you just ran <code>self-bench login</code>.</p>
<form method="post" action="/auth/cli">${hidden}<button type="submit">Authorize</button></form>`);
  };

  return {
    /** Answers /auth/cli and /auth/cli/token; true when the response was sent. */
    async handle(request: IncomingMessage, url: URL, response: ServerResponse): Promise<boolean> {
      const method = request.method ?? "GET";
      if (url.pathname === "/auth/cli/token" && method === "POST") {
        const body = tokenSchema.safeParse(
          JSON.parse((await readBody(request, 8192)).toString() || "{}"),
        );
        const claims = body.success ? opened(body.data.code) : undefined;
        const challenge = body.success
          ? createHash("sha256").update(body.data.verifier).digest("base64url")
          : "";
        const user =
          claims && constantTimeEqual(challenge, claims.challenge)
            ? await options.users.findByGitHubId(claims.user)
            : undefined;
        if (!claims || !user || !options.apiKeys) {
          sendJson(response, 400, {
            error: "This sign-in expired or was already used. Run self-bench login again.",
          });
          return true;
        }
        const created = await options.apiKeys.create(user.id, {
          name: `CLI on ${claims.name}`,
          scope: "write",
        });
        response.setHeader("cache-control", "no-store");
        sendJson(response, 201, { ...created, user: { login: user.login } });
        return true;
      }
      if (url.pathname !== "/auth/cli" || (method !== "GET" && method !== "POST")) return false;
      const params =
        method === "GET"
          ? url.searchParams
          : new URLSearchParams((await readBody(request, 8192)).toString());
      const asked = parsed(params);
      if (!asked) {
        sendJson(response, 400, { error: "Start sign-in from self-bench login." });
        return true;
      }
      const user = await options.sessionUser(request);
      if (!user) {
        const next = `/auth/cli?${new URLSearchParams(asked)}`;
        sendRedirect(response, `/auth/github?next=${encodeURIComponent(next)}`);
        return true;
      }
      if (method === "GET") {
        approve(response, asked, user);
        return true;
      }
      // A form post from another site carries a foreign Origin; the approval page's own does not.
      const origin = request.headers.origin;
      if (origin && origin !== new URL(options.config.publicUrl).origin) {
        sendJson(response, 403, { error: "Approve sign-in from the SelfBench page." });
        return true;
      }
      const payload = Buffer.from(
        JSON.stringify({
          user: user.githubId,
          challenge: asked.challenge,
          name: asked.name,
          expires: options.now().getTime() + CODE_TTL_MS,
        }),
      ).toString("base64url");
      const callback = new URL(asked.callback);
      callback.searchParams.set("code", sign(payload));
      callback.searchParams.set("state", asked.state);
      sendRedirect(response, callback.toString());
      return true;
    },
  };
}
