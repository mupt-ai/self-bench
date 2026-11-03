import { createSessionSigner, SESSION_COOKIE } from "../../src/api/auth/session.js";
import { testAuthConfig } from "./site-fixture.js";

const signer = createSessionSigner(testAuthConfig.sessionSecret);

/**
 * Requests to a test server at `origin()` as the app sends them: same-origin JSON, signed in as
 * the GitHub user `githubId` unless it is null.
 */
export function sessionFetch(origin: () => string) {
  return (path: string, init: RequestInit = {}, githubId: number | null = 1) =>
    fetch(`${origin()}${path}`, {
      ...init,
      headers: {
        origin: origin(),
        "content-type": "application/json",
        ...(githubId === null ? {} : { cookie: `${SESSION_COOKIE}=${signer.issue(githubId)}` }),
        ...init.headers,
      },
    });
}
