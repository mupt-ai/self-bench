import { Navigate, Route, Routes } from "react-router";
import { PublicLayout } from "./PublicLayout";
import { GroupPage } from "./pages/GroupPage";
import { HomePage } from "./pages/HomePage";
import { RepoPage } from "./pages/RepoPage";

/**
 * URLs mirror GitHub: /owner/name, and /owner/name/publisher for one workspace's line. A
 * repository group is /groups/publisher/slug; GitHub has no account named `groups`. The
 * directory lists repositories at / and public benchmarks at /evals; a benchmark's page is
 * /evals/org/name, by its registry name, with /evals/org/name/publisher for one workspace's line.
 */
export function PublicRoutes() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<HomePage key="repositories" view="repositories" />} />
        <Route path="evals" element={<HomePage key="benchmarks" view="benchmarks" />} />
        <Route path="evals/:owner/:name" element={<RepoPage benchmark />} />
        <Route path="evals/:owner/:name/:publisher" element={<RepoPage benchmark />} />
        <Route path="groups/:publisher/:slug" element={<GroupPage />} />
        <Route path=":owner/:name" element={<RepoPage />} />
        <Route path=":owner/:name/:publisher" element={<RepoPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
