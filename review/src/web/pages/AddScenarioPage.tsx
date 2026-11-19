import { useNavigate } from "react-router";
import { isEvalName } from "../../../../src/contracts/evals";
import { AddScenarioSheet } from "../AddScenarioSheet";
import { repoPagePath, useRepoParams } from "../paths";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { RepoPage } from "./RepoPage";

/**
 * Add Custom Task opens the sheet over the dataset: in a repository, the agent starts from the
 * repository at a commit; in a custom benchmark, from files the author writes.
 */
export function AddScenarioPage() {
  const { owner, name } = useRepoParams();
  const { org } = useOrg();
  const navigate = useNavigate();
  const fullName = `${owner}/${name}`;
  const start = isEvalName(fullName) ? "workspace" : "repository";
  useDocumentTitle(`Add Custom Task · ${fullName}`);
  return (
    <>
      <RepoPage />
      <AddScenarioSheet
        key={`${org.login}/${fullName}/${start}`}
        org={org}
        fullName={fullName}
        start={start}
        onClose={() => void navigate(repoPagePath(fullName))}
        onComplete={() => void navigate(`${repoPagePath(fullName)}?state=in_progress`)}
      />
    </>
  );
}
