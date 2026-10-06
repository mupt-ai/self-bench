import type { comparisonProgress } from "../../../../src/evaluation/comparison-progress";
import type { GroupEvaluationDraft } from "../../../../src/evaluation/group-evaluations";
import { requestJson } from "../api";
import type { EvaluationRun } from "../evaluation/api";

/** A group as lists show it: its members by name. */
export interface RepoGroup {
  id: string;
  name: string;
  createdAt: string;
  repos: string[];
}

export type GroupSettings = Omit<GroupEvaluationDraft, "id">;

export interface GroupDetail {
  group: Omit<RepoGroup, "repos"> & { repos: { fullName: string; approvedTasks: number }[] };
  evaluations: {
    id: string;
    createdAt: string;
    createdBy: string;
    settings: GroupSettings;
    repos: number;
  }[];
}

/** A member as a group evaluation ran it: its comparison's progress and runs, or why it didn't. */
type GroupEvaluationRepo =
  | { fullName: string; skipped: string }
  | {
      fullName: string;
      comparisonId: string;
      progress: ReturnType<typeof comparisonProgress>;
      runs: EvaluationRun[];
    };

export interface GroupEvaluation {
  id: string;
  groupId: string;
  groupName: string;
  createdAt: string;
  createdBy: string;
  settings: GroupSettings;
  repos: GroupEvaluationRepo[];
  submissionError?: string;
}

export function groupsUrl(org: string, ...path: string[]) {
  return [`/api/orgs/${encodeURIComponent(org)}/groups`, ...path].join("/");
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export async function fetchGroups(org: string): Promise<RepoGroup[]> {
  return (await requestJson<{ groups: RepoGroup[] }>(groupsUrl(org))).groups;
}

/** Creates a group, or with `id` renames one and replaces its members. */
export async function saveGroup(
  org: string,
  draft: { name: string; repos: string[] },
  id?: string,
): Promise<RepoGroup> {
  const url = id ? groupsUrl(org, id) : groupsUrl(org);
  return (await requestJson<{ group: RepoGroup }>(url, json(id ? "PUT" : "POST", draft))).group;
}

export async function deleteGroup(org: string, id: string): Promise<void> {
  await requestJson(groupsUrl(org, id), { method: "DELETE" });
}
