import { Navigate, Route, Routes } from "react-router";
import { PublicLayout } from "./PublicLayout";
import { GroupPage } from "./pages/GroupPage";
import { HomePage } from "./pages/HomePage";
import { RepoPage } from "./pages/RepoPage";

/**
 * URLs mirror GitHub: /owner/name, and /owner/name/publisher for one workspace's line. A
 * repository group is /groups/publisher/slug; GitHub has no account named `groups`.
 */
export function PublicRoutes() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<HomePage />} />
        <Route path="groups/:publisher/:slug" element={<GroupPage />} />
        <Route path=":owner/:name" element={<RepoPage />} />
        <Route path=":owner/:name/:publisher" element={<RepoPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
