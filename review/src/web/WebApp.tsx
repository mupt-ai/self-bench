import React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";
import {
  fetchSession,
  requestSignOut,
  SessionContext,
  type SessionState,
  useSession,
} from "./session";
import "./web.css";

/**
 * selfbench.dev. One session probe on boot decides between the login page and the shell;
 * every route lives under the `.sb` root so the site's tokens apply.
 */
export function WebApp() {
  const [session, setSession] = React.useState<SessionState>({ status: "loading" });
  React.useEffect(() => {
    let cancelled = false;
    void fetchSession().then((found) => {
      if (!cancelled) setSession(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const signOut = React.useCallback(async () => {
    await requestSignOut();
    setSession({ status: "anonymous" });
  }, []);
  const value = React.useMemo(() => ({ session, signOut }), [session, signOut]);
  return (
    <SessionContext.Provider value={value}>
      <div className="sb">
        {session.status === "loading" ? null : (
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="*" element={<RequireUser />} />
            </Routes>
          </BrowserRouter>
        )}
      </div>
    </SessionContext.Provider>
  );
}

function RequireUser() {
  const { session } = useSession();
  if (session.status !== "signed-in") return <Navigate to="/login" replace />;
  return <HomePage user={session.user} orgs={session.orgs} />;
}
