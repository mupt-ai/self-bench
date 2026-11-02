import { useParams } from "react-router";
import { BatchProvider } from "./batches/BatchProvider";
import { ScopeLayout } from "./ScopeLayout";
import { useOrg } from "./SiteLayout";

/** A repository's pages: a benchmark's, plus the tabs that generate, publish, and tune its tasks. */
export function RepoLayout() {
  const { owner, name } = useParams();
  const { org } = useOrg();
  const repo = `${owner}/${name}`;
  return (
    <BatchProvider key={`${org.login}/${repo}`} repoId={{ org: org.login, fullName: repo }}>
      <ScopeLayout
        afterDataset={[{ path: "/batches", label: "Batch Generation" }]}
        afterResults={[
          { path: "/releases", label: "Releases" },
          { path: "/settings", label: "Settings" },
        ]}
      />
    </BatchProvider>
  );
}
