import type { GenerationSettings } from "../../../src/generation/settings/settings";
import { repoPath, requestJson, type TaskItem } from "./api";

export async function addPullRequest(
  org: string,
  fullName: string,
  pr: string,
  generation?: GenerationSettings,
): Promise<TaskItem> {
  const body = await requestJson<{ task: TaskItem }>(`${repoPath(org, fullName)}/tasks/from-pr`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pr, ...(generation ? { generation } : {}) }),
  });
  return body.task;
}

export interface ScenarioInput {
  title: string;
  scenario: string;
  difficulty: "easy" | "medium" | "hard";
  /** Each file's name and base64 contents. */
  attachments: { name: string; content: string }[];
  /** A repository scenario's starting commit or branch; a workspace scenario has none. */
  commit?: string;
}

/** A described scenario becomes one task, as a PR does from Add PRs. */
export async function addScenario(
  org: string,
  fullName: string,
  scenario: ScenarioInput,
  generation?: GenerationSettings,
): Promise<TaskItem> {
  const body = await requestJson<{ task: TaskItem }>(
    `${repoPath(org, fullName)}/tasks/from-scenario`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...scenario, ...(generation ? { generation } : {}) }),
    },
  );
  return body.task;
}
