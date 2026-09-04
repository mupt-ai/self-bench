import React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { LoginPage } from "./pages/LoginPage";
import { RepoPage } from "./pages/RepoPage";
import { ReposPage } from "./pages/ReposPage";
import { TaskPage } from "./pages/TaskPage";
import { SiteLayout } from "./SiteLayout";
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
              <Route element={<RequireUser />}>
                <Route index element={<ReposPage />} />
                <Route path="repos/:owner/:name" element={<RepoPage />} />
                <Route path="repos/:owner/:name/tasks/:runId/:taskId" element={<TaskPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
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
  return <SiteLayout user={session.user} orgs={session.orgs} />;
}
