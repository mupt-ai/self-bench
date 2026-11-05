import { useNavigate, useParams } from "react-router";
import { AddScenarioSheet, type ScenarioStart } from "../AddScenarioSheet";
import { useOrg } from "../SiteLayout";
import { useDocumentTitle } from "../session";
import { RepoPage } from "./RepoPage";

/**
 * Add Scenario (the repository at a commit) and Add Workspace Scenario (files the author writes)
 * open the same sheet over the repository's dataset.
 */
export function AddScenarioPage({ start }: { start: ScenarioStart }) {
  const { owner, name } = useParams();
  const { org } = useOrg();
  const navigate = useNavigate();
  const fullName = `${owner}/${name}`;
  useDocumentTitle(
    `${start === "repository" ? "Add Scenario" : "Add Workspace Scenario"} · ${fullName}`,
  );
  return (
    <>
      <RepoPage />
      <AddScenarioSheet
        key={`${org.login}/${fullName}/${start}`}
        org={org}
        fullName={fullName}
        start={start}
        onClose={() => void navigate(`/repos/${fullName}`)}
        onComplete={() => void navigate(`/repos/${fullName}?state=in_progress`)}
      />
    </>
  );
}
