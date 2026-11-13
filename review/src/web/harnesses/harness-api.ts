import type { SavedHarnessDraft } from "../../../../src/contracts/saved-harnesses";
import type { SavedHarness } from "../../../../src/db/saved-harnesses";
import type { CatalogModel } from "../../../../src/evaluation/catalog";
import { requestJson } from "../api";

export type { SavedHarness };

const harnessesPath = (org: string) => `/api/orgs/${encodeURIComponent(org)}/harnesses`;
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** The workspace's saved harnesses, by name. */
export async function listHarnesses(org: string): Promise<SavedHarness[]> {
  return (await requestJson<{ harnesses: SavedHarness[] }>(harnessesPath(org))).harnesses;
}

/** The models a saved harness's subagents can run on, and whether the managed key serves them. */
export async function listSubagentModels(
  org: string,
): Promise<{ models: CatalogModel[]; managed?: boolean }> {
  return requestJson(`${harnessesPath(org)}/models`);
}

/** Saves a new harness, or replaces the one with `id`. */
export async function saveHarness(
  org: string,
  harness: SavedHarnessDraft,
  id?: number,
): Promise<SavedHarness> {
  const reply = await requestJson<{ harness: SavedHarness }>(
    id === undefined ? harnessesPath(org) : `${harnessesPath(org)}/${id}`,
    json(id === undefined ? "POST" : "PUT", harness),
  );
  return reply.harness;
}

export async function deleteHarness(org: string, id: number): Promise<void> {
  await requestJson(`${harnessesPath(org)}/${id}`, { method: "DELETE" });
}
