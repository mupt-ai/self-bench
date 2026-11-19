import { useParams } from "react-router";
import { EVAL_OWNER } from "../../../src/contracts/evals";

/**
 * The app's addresses for its three kinds of benchmark: Repo Benchmarks under `/repos`, Public
 * Benchmarks under `/public`, and Custom Benchmarks under `/custom`. A custom benchmark is stored
 * as a repository owned by `evals`, but its pages live at `/custom/<name>`.
 */
const REPOS_PATH = "/repos";
const PUBLIC_PATH = "/public";
const CUSTOM_PATH = "/custom";

/** A repository's or a custom benchmark's pages, from its stored `owner/name`. */
export function repoPagePath(fullName: string): string {
  const prefix = `${EVAL_OWNER}/`;
  return fullName.startsWith(prefix)
    ? `${CUSTOM_PATH}/${fullName.slice(prefix.length)}`
    : `${REPOS_PATH}/${fullName}`;
}

/** A public benchmark's pages, from its registry `org/name`. */
export function publicPagePath(fullName: string): string {
  return `${PUBLIC_PATH}/${fullName}`;
}

/**
 * The route's parameters, with a custom benchmark's implied owner filled in: its routes
 * (`/custom/:name`) name no owner.
 */
export function useRepoParams(): Record<string, string | undefined> & { owner?: string } {
  const params = useParams();
  return params.owner || !params.name ? params : { ...params, owner: EVAL_OWNER };
}
