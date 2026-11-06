import { type ConnectedRepo, requestJson } from "./api";

/** Creates an eval; its dataset, runs, and results are at /repos/evals/<slug>. */
export async function createEval(org: string, name: string): Promise<ConnectedRepo> {
  const body = await requestJson<{ repo: ConnectedRepo }>(
    `/api/orgs/${encodeURIComponent(org)}/evals`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
  );
  return body.repo;
}
