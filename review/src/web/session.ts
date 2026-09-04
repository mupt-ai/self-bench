import React from "react";

export interface SiteUser {
  login: string;
  name?: string;
  avatarUrl?: string;
}

/** A tenant: a GitHub org, or the user's own account (`kind: "user"`). */
export interface SiteOrg {
  login: string;
  kind: "org" | "user";
  role: "admin" | "member";
  name?: string;
  avatarUrl?: string;
}

export type SessionState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "signed-in"; user: SiteUser; orgs: SiteOrg[] };

export interface SessionContextValue {
  session: SessionState;
  signOut(): Promise<void>;
}

export const SessionContext = React.createContext<SessionContextValue>({
  session: { status: "loading" },
  signOut: async () => undefined,
});

export function useSession(): SessionContextValue {
  return React.useContext(SessionContext);
}

/** Asks the server who is signed in; a 401 means nobody, anything else unexpected is anonymous too. */
export async function fetchSession(): Promise<SessionState> {
  try {
    const response = await fetch("/api/me", { headers: { accept: "application/json" } });
    if (!response.ok) return { status: "anonymous" };
    const body = (await response.json()) as { user: SiteUser; orgs?: SiteOrg[] };
    return { status: "signed-in", user: body.user, orgs: body.orgs ?? [] };
  } catch {
    return { status: "anonymous" };
  }
}

export async function requestSignOut(): Promise<void> {
  await fetch("/auth/logout", { method: "POST" });
}

const LAST_ORG_KEY = "selfbench.org";

/** The org a bare "/" should open: the last one chosen here, else the personal account. */
export function defaultOrg(orgs: SiteOrg[]): SiteOrg | undefined {
  let remembered: string | null = null;
  try {
    remembered = window.localStorage.getItem(LAST_ORG_KEY);
  } catch {
    // storage unavailable
  }
  return (
    orgs.find((org) => org.login.toLowerCase() === remembered?.toLowerCase()) ??
    orgs.find((org) => org.kind === "user") ??
    orgs[0]
  );
}

export function rememberOrg(login: string): void {
  try {
    window.localStorage.setItem(LAST_ORG_KEY, login);
  } catch {
    // storage unavailable; the choice lives in the URL only
  }
}

export function findOrg(orgs: SiteOrg[], login: string | undefined): SiteOrg | undefined {
  if (!login) return undefined;
  return orgs.find((org) => org.login.toLowerCase() === login.toLowerCase());
}

export function useDocumentTitle(title: string): void {
  React.useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
