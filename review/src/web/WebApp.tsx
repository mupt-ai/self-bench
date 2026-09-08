import React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { SESSION_EXPIRED } from "../session-expired";
import { ComparisonPage } from "./evaluation/ComparisonPage";
import { CredentialsPage } from "./evaluation/CredentialsPage";
import { EvaluationPage } from "./evaluation/EvaluationPage";
import { RunPage } from "./evaluation/RunPage";
import { AddPrPage } from "./pages/AddPrPage";
import { LoginPage } from "./pages/LoginPage";
import { RepoPage } from "./pages/RepoPage";
import { ReposPage } from "./pages/ReposPage";
import { TaskPage } from "./pages/TaskPage";
import { RepoLayout } from "./RepoLayout";
import { SiteLayout } from "./SiteLayout";
import {
  fetchSession,
  requestSignOut,
  SessionContext,
  type SessionState,
  useSession,
} from "./session";

/**
 * selfbench.dev. One session probe on boot decides between the login page and the shell;
 * every route lives under the `.sb` root so the site's tokens apply.
 */
export function WebApp() {
  const [session, setSession] = React.useState<SessionState>({ status: "loading" });
  React.useEffect(() => {
    let cancelled = false;
    const expired = () => {
      cancelled = true;
      setSession({ status: "anonymous" });
    };
    window.addEventListener(SESSION_EXPIRED, expired);
    void fetchSession().then((found) => {
      if (!cancelled) setSession(found);
    });
    return () => {
      cancelled = true;
      window.removeEventListener(SESSION_EXPIRED, expired);
    };
  }, []);
  const signOut = React.useCallback(async () => {
    await requestSignOut();
    setSession({ status: "anonymous" });
  }, []);
  const value = React.useMemo(() => ({ session, signOut }), [session, signOut]);
  return (
    <SessionContext.Provider value={value}>
      <div className="sb min-h-full bg-bg font-sans text-base leading-normal text-ink antialiased [&_a]:no-underline [&_button:not(:disabled)]:cursor-pointer [&_:focus-visible]:outline-2 [&_:focus-visible]:outline-mint-bright [&_:focus-visible]:outline-offset-2 motion-reduce:[&_*]:transition-none">
        {session.status === "loading" ? null : (
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route element={<RequireUser />}>
                <Route index element={<ReposPage />} />
                <Route path="settings/credentials" element={<CredentialsPage />} />
                <Route path="repos/:owner/:name" element={<RepoLayout />}>
                  <Route index element={<RepoPage />} />
                  <Route path="add-prs" element={<AddPrPage />} />
                  <Route path="evaluations" element={<EvaluationPage />} />
                  <Route path="results" element={<EvaluationPage />} />
                  <Route path="dataset" element={<Navigate to=".." replace />} />
                  <Route path="run" element={<RunPage />} />
                  <Route
                    path="settings/credentials"
                    element={<Navigate to="/settings/credentials" replace />}
                  />
                  <Route path="comparisons/:comparisonId" element={<ComparisonPage />} />
                </Route>
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
