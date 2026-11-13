import type { SavedConditionDraft } from "../../../../src/contracts/conditions";
import type { SavedCondition } from "../../../../src/db/saved-conditions";
import { requestJson } from "../api";

export type { SavedCondition };

const conditionsPath = (org: string) => `/api/orgs/${encodeURIComponent(org)}/conditions`;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** The workspace's saved conditions, by name. */
export async function listConditions(org: string): Promise<SavedCondition[]> {
  return (await requestJson<{ conditions: SavedCondition[] }>(conditionsPath(org))).conditions;
}

/** The models a condition's subagents can run on. */
export async function listSubagentModels(org: string): Promise<{ id: string; label: string }[]> {
  return (
    await requestJson<{ models: { id: string; label: string }[] }>(`${conditionsPath(org)}/models`)
  ).models;
}

/** Saves a new condition, or replaces the one with `id`. */
export async function saveCondition(
  org: string,
  condition: SavedConditionDraft,
  id?: number,
): Promise<SavedCondition> {
  const reply = await requestJson<{ condition: SavedCondition }>(
    id === undefined ? conditionsPath(org) : `${conditionsPath(org)}/${id}`,
    json(id === undefined ? "POST" : "PUT", condition),
  );
  return reply.condition;
}

export async function deleteCondition(org: string, id: number): Promise<void> {
  await requestJson(`${conditionsPath(org)}/${id}`, { method: "DELETE" });
}
