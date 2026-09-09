import { useParams } from "react-router";
import { useOrg } from "../SiteLayout";
import { evaluationUrl } from "./api";

export function useEvaluationScope() {
  const { org } = useOrg();
  const { owner = "", name = "" } = useParams();
  const repo = `${owner}/${name}`;
  return { repo, url: evaluationUrl(org.login, repo) };
}
