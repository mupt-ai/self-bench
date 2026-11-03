import { useNavigate, useParams } from "react-router";
import { AddScenarioSheet } from "../AddScenarioSheet";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { RepoPage } from "./RepoPage";

export function AddScenarioPage() {
  const { owner, name } = useParams();
  const { org } = useOrg();
  const navigate = useNavigate();
  const fullName = `${owner}/${name}`;
  useDocumentTitle(`Add Scenario · ${fullName}`);
  return (
    <>
      <RepoPage />
      <AddScenarioSheet
        key={`${org.login}/${fullName}`}
        org={org}
        fullName={fullName}
        onClose={() => void navigate(`/repos/${fullName}`)}
        onComplete={() => void navigate(`/repos/${fullName}?state=in_progress`)}
      />
    </>
  );
}
