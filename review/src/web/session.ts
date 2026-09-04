import React from "react";

export interface SiteUser {
  login: string;
  name?: string;
  avatarUrl?: string;
}

export type SessionState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "signed-in"; user: SiteUser };

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
    const body = (await response.json()) as { user: SiteUser };
    return { status: "signed-in", user: body.user };
  } catch {
    return { status: "anonymous" };
  }
}

export async function requestSignOut(): Promise<void> {
  await fetch("/auth/logout", { method: "POST" });
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
