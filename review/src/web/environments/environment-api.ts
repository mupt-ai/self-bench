import type { EnvironmentItem, EnvironmentTaskItem } from "../../../../src/contracts/variants";
import type { GenerationSettings } from "../../../../src/generation/settings/settings";
import { repoPath, requestJson } from "../api";

export type { EnvironmentItem, EnvironmentTaskItem };

/** A new environment: its name, and the script run in every approved task's image. */
interface EnvironmentInput {
  name: string;
  script: string;
}

const environmentsPath = (org: string, fullName: string) =>
  `${repoPath(org, fullName)}/environments`;

export async function listEnvironments(org: string, fullName: string): Promise<EnvironmentItem[]> {
  return (await requestJson<{ environments: EnvironmentItem[] }>(environmentsPath(org, fullName)))
    .environments;
}

export async function getEnvironment(
  org: string,
  fullName: string,
  id: number,
): Promise<{ environment: EnvironmentItem; tasks: EnvironmentTaskItem[] }> {
  return requestJson(`${environmentsPath(org, fullName)}/${id}`);
}

/** What a build started, and the tasks it could not start, each with why. */
export interface EnvironmentBuild {
  environment: EnvironmentItem;
  failures?: string[];
}

/** Saves an environment and builds every approved task in it, each checked once. */
export async function createEnvironment(
  org: string,
  fullName: string,
  environment: EnvironmentInput,
  generation?: GenerationSettings,
): Promise<EnvironmentBuild> {
  return requestJson<EnvironmentBuild>(environmentsPath(org, fullName), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environment, ...(generation ? { generation } : {}) }),
  });
}

/** Builds the approved tasks an environment has none ready or checking for. */
export async function buildEnvironment(
  org: string,
  fullName: string,
  id: number,
  generation?: GenerationSettings,
): Promise<EnvironmentBuild> {
  return requestJson<EnvironmentBuild>(`${environmentsPath(org, fullName)}/${id}/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(generation ? { generation } : {}),
  });
}

export async function deleteEnvironment(org: string, fullName: string, id: number): Promise<void> {
  await requestJson(`${environmentsPath(org, fullName)}/${id}`, { method: "DELETE" });
}
