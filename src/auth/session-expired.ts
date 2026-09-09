import type { ServerResponse } from "node:http";
import { sendJson } from "../api/http.js";
import { clearCookie } from "./cookies.js";
import { GitHubOAuthError } from "./github.js";
import { SESSION_COOKIE } from "./session.js";

/** Only an authentication failure logs out the browser; permission/rate-limit errors do not. */
export function sendExpiredSession(
  response: ServerResponse,
  error: unknown,
  publicUrl: string,
): boolean {
  if (!(error instanceof GitHubOAuthError) || error.status !== 401) return false;
  clearCookie(response, SESSION_COOKIE, { secure: publicUrl.startsWith("https://") });
  response.setHeader("cache-control", "no-store");
  sendJson(response, 401, {
    error: "GitHub authorization expired. Sign in again.",
    code: "session_expired",
  });
  return true;
}
