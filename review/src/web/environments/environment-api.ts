import type { EnvironmentItem, EnvironmentTaskItem } from "../../../../src/contracts/variants";
import type { GenerationSettings } from "../../../../src/generation/settings/settings";
import { repoPath, requestJson } from "../api";

export type { EnvironmentItem, EnvironmentTaskItem };

/** What an environment changes in every approved task (generation/tasks/variant.ts). */
export interface EnvironmentInput {
  name: string;
  packages: { name: string; spec: string; directory: string }[];
  files: { path: string; mode: "replace" | "append" | "delete"; content: string }[];
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

/** Saves an environment and builds every approved task in it, each checked once. */
export async function createEnvironment(
  org: string,
  fullName: string,
  environment: EnvironmentInput,
  generation?: GenerationSettings,
): Promise<EnvironmentItem> {
  const body = await requestJson<{ environment: EnvironmentItem }>(
    environmentsPath(org, fullName),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environment, ...(generation ? { generation } : {}) }),
    },
  );
  return body.environment;
}

/** Builds the approved tasks an environment has none ready or checking for. */
export async function buildEnvironment(
  org: string,
  fullName: string,
  id: number,
  generation?: GenerationSettings,
): Promise<void> {
  await requestJson(`${environmentsPath(org, fullName)}/${id}/build`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(generation ? { generation } : {}),
  });
}

export async function deleteEnvironment(org: string, fullName: string, id: number): Promise<void> {
  await requestJson(`${environmentsPath(org, fullName)}/${id}`, { method: "DELETE" });
}
