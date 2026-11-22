import React from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { SESSION_EXPIRED } from "../session-expired";
import { forgetPerson, identifyPerson } from "../telemetry";
import { BatchesPage } from "./batches/BatchesPage";
import { BatchPage } from "./batches/BatchPage";
import { BenchmarkDatasetPage } from "./benchmarks/BenchmarkDatasetPage";
import { BenchmarkLayout } from "./benchmarks/BenchmarkLayout";
import { BenchmarkReleasesPage } from "./benchmarks/BenchmarkReleasesPage";
import { BenchmarksPage } from "./benchmarks/BenchmarksPage";
import { BenchmarkTaskPage } from "./benchmarks/BenchmarkTaskPage";
import { ErrorBoundary } from "./ErrorBoundary";
import { EnvironmentsPage } from "./environments/EnvironmentsPage";
import { CredentialsPage } from "./evaluation/CredentialsPage";
import { DemoRunPage } from "./evaluation/DemoRunPage";
import { EvaluationPage } from "./evaluation/EvaluationPage";
import { RunPage } from "./evaluation/RunPage";
import { GroupDatasetPage } from "./groups/GroupDatasetPage";
import { GroupLayout } from "./groups/GroupLayout";
import { GroupReleasesPage } from "./groups/GroupReleasesPage";
import { GroupSettingsPage } from "./groups/GroupSettingsPage";
import { HarnessesPage } from "./harnesses/HarnessesPage";
import { SiteSkeleton } from "./LoadingSkeleton";
import { AddPrPage } from "./pages/AddPrPage";
import { AddScenarioPage } from "./pages/AddScenarioPage";
import { EvalsPage } from "./pages/EvalsPage";
import { LoginPage } from "./pages/LoginPage";
import { RepoPage } from "./pages/RepoPage";
import { RepoSettingsPage } from "./pages/RepoSettingsPage";
import { ReposPage } from "./pages/ReposPage";
import { TaskPage } from "./pages/TaskPage";
import { RepoLayout } from "./RepoLayout";
import { ReleasesPage } from "./releases/ReleasesPage";
import { SiteLayout } from "./SiteLayout";
import {
  fetchSession,
  requestSignOut,
  SessionContext,
  type SessionState,
  useSession,
} from "./session";
import { ApiKeysPage } from "./settings/ApiKeysPage";
import { BillingPage } from "./settings/BillingPage";
import { MembersPage } from "./settings/MembersPage";

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
      // Whoever signs in next may be someone else; their events must not join this person's.
      forgetPerson();
      setSession({ status: "anonymous" });
    };
    window.addEventListener(SESSION_EXPIRED, expired);
    void fetchSession().then((found) => {
      if (cancelled) return;
      // A session that ended while the page was closed leaves its person identified.
      if (found.status === "anonymous") forgetPerson();
      setSession(found);
    });
    return () => {
      cancelled = true;
      window.removeEventListener(SESSION_EXPIRED, expired);
    };
  }, []);
  React.useEffect(() => {
    if (session.status === "signed-in") identifyPerson(session.user);
  }, [session]);
  const signOut = React.useCallback(async () => {
    await requestSignOut();
    forgetPerson();
    setSession({ status: "anonymous" });
  }, []);
  const value = React.useMemo(() => ({ session, signOut }), [session, signOut]);
  return (
    <SessionContext.Provider value={value}>
      <div className="sb min-h-full bg-background font-sans text-sm leading-6 text-foreground antialiased [&_a]:no-underline [&_button:not(:disabled)]:cursor-pointer [&_:focus-visible]:outline-1 [&_:focus-visible]:outline-ring [&_:focus-visible]:outline-offset-1 motion-reduce:[&_*]:transition-none">
        {session.status === "loading" ? (
          <SiteSkeleton />
        ) : (
          <BrowserRouter>
            <ErrorBoundary>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/demo/run" element={<DemoRunPage />} />
                <Route element={<RequireUser />}>
                  <Route index element={<Navigate to="/repos" replace />} />
                  <Route path="repos" element={<ReposPage />} />
                  <Route path="settings/credentials" element={<CredentialsPage />} />
                  <Route path="settings/api-keys" element={<ApiKeysPage />} />
                  <Route path="settings/members" element={<MembersPage />} />
                  <Route path="settings/harnesses" element={<HarnessesPage />} />
                  <Route
                    path="settings/conditions"
                    element={<Navigate to="/settings/harnesses" replace />}
                  />
                  {session.status === "signed-in" && session.managedOffering && (
                    <Route path="settings/billing" element={<BillingPage />} />
                  )}
                  <Route path="custom" element={<EvalsPage />} />
                  <Route path="evals" element={<Navigate to="/custom" replace />} />
                  <Route
                    path="repos/evals/:name/*"
                    element={<MovedTo prefix="/custom" from={3} />}
                  />
                  <Route path="benchmarks/*" element={<MovedTo prefix="/public" from={2} />} />
                  <Route path="groups" element={<Navigate to="/repos" replace />} />
                  <Route path="groups/:slug" element={<GroupLayout />}>
                    <Route index element={<GroupDatasetPage />} />
                    <Route path="run" element={<RunPage />} />
                    <Route path="results" element={<EvaluationPage />} />
                    <Route path="releases" element={<GroupReleasesPage />} />
                    <Route path="settings" element={<GroupSettingsPage />} />
                  </Route>
                  <Route path="public" element={<BenchmarksPage />} />
                  <Route path="public/:owner/:name" element={<BenchmarkLayout />}>
                    <Route index element={<BenchmarkDatasetPage />} />
                    <Route path="run" element={<RunPage />} />
                    <Route path="results" element={<EvaluationPage />} />
                    <Route path="releases" element={<BenchmarkReleasesPage />} />
                  </Route>
                  <Route path="repos/:owner/:name" element={<RepoLayout />}>
                    {repoRoutes()}
                  </Route>
                  <Route path="custom/:name" element={<RepoLayout />}>
                    {repoRoutes()}
                  </Route>
                  <Route path="repos/:owner/:name/tasks/:runId/:taskId" element={<TaskPage />} />
                  <Route path="custom/:name/tasks/:runId/:taskId" element={<TaskPage />} />
                  <Route path="public/:owner/:name/tasks/*" element={<BenchmarkTaskPage />} />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </ErrorBoundary>
          </BrowserRouter>
        )}
      </div>
    </SessionContext.Provider>
  );
}

function RequireUser() {
  const { session } = useSession();
  if (session.status !== "signed-in") return <Navigate to="/login" replace />;
  return (
    <SiteLayout user={session.user} orgs={session.orgs} managedOffering={session.managedOffering} />
  );
}

/** A repository's or custom benchmark's pages, the same under `/repos/:owner/:name` and `/custom/:name`. */
function repoRoutes() {
  return (
    <>
      <Route index element={<RepoPage />} />
      <Route path="batches" element={<BatchesPage />} />
      <Route path="batches/:batchId" element={<BatchPage />} />
      <Route path="add-prs" element={<AddPrPage />} />
      <Route path="add-task" element={<AddScenarioPage />} />
      <Route path="add-scenario" element={<Navigate to="../add-task" replace />} />
      <Route path="add-workspace-scenario" element={<Navigate to="../add-task" replace />} />
      <Route path="evaluations" element={<EvaluationPage />} />
      <Route path="results" element={<EvaluationPage />} />
      <Route path="releases" element={<ReleasesPage />} />
      <Route path="dataset" element={<Navigate to=".." replace />} />
      <Route path="run" element={<RunPage />} />
      <Route path="environments" element={<EnvironmentsPage />} />
      <Route path="settings" element={<RepoSettingsPage />} />
      <Route
        path="settings/credentials"
        element={<Navigate to="/settings/credentials" replace />}
      />
    </>
  );
}

/** An old address (`/benchmarks/...`, `/repos/evals/...`): the same page at its new one. */
function MovedTo({ prefix, from }: { prefix: string; from: number }) {
  const { pathname, search, hash } = useLocation();
  const rest = pathname.split("/").slice(from).join("/");
  return <Navigate to={`${prefix}${rest ? `/${rest}` : ""}${search}${hash}`} replace />;
}
