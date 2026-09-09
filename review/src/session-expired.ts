export const SESSION_EXPIRED = "selfbench:session-expired";

/** Notify the site shell without redirecting standalone bearer-token viewers. */
export function checkSessionExpired(response: Pick<Response, "status">): void {
  if (response.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event(SESSION_EXPIRED));
  }
}
