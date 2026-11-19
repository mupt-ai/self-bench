import { useNavigate } from "react-router";
import { AddPrSheet } from "../AddPrSheet";
import { repoPagePath, useRepoParams } from "../paths";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { RepoPage } from "./RepoPage";

export function AddPrPage() {
  const { owner, name } = useRepoParams();
  const { org } = useOrg();
  const navigate = useNavigate();
  const fullName = `${owner}/${name}`;
  useDocumentTitle(`Add PRs · ${fullName}`);
  return (
    <>
      <RepoPage />
      <AddPrSheet
        key={`${org.login}/${fullName}`}
        org={org}
        fullName={fullName}
        onClose={() => void navigate(repoPagePath(fullName))}
        onComplete={() => void navigate(`${repoPagePath(fullName)}?state=in_progress`)}
      />
    </>
  );
}
