import { useParams } from "react-router";
import { isEvalName } from "../../../src/contracts/evals";
import { BatchProvider } from "./batches/BatchProvider";
import { ScopeLayout } from "./ScopeLayout";
import { useOrg } from "./SiteLayout";

/**
 * A repository's pages: a benchmark's, plus the tabs that generate, publish, and tune its tasks,
 * and its environments. An eval has no pull requests to batch and is never released.
 */
export function RepoLayout() {
  const { owner, name } = useParams();
  const { org } = useOrg();
  const repo = `${owner}/${name}`;
  const evalScope = isEvalName(repo);
  return (
    <BatchProvider key={`${org.login}/${repo}`} repoId={{ org: org.login, fullName: repo }}>
      <ScopeLayout
        afterDataset={[
          ...(evalScope ? [] : [{ path: "/batches", label: "Batch Generation" }]),
          { path: "/environments", label: "Repo Ablations" },
        ]}
        afterResults={[
          ...(evalScope ? [] : [{ path: "/releases", label: "Releases" }]),
          { path: "/settings", label: "Settings" },
        ]}
      />
    </BatchProvider>
  );
}
