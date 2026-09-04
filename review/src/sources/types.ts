import type { CandidateArtifacts, TaskFiles, TaskRow } from "../types";

export type SourceKind = "run" | "local";

/**
 * Where the ledger's rows come from. Every source can list tasks and open one task's
 * files; run mode also exposes the pipeline artifacts behind each candidate.
 */
export interface TaskSource {
  kind: SourceKind;
  label: string;
  summary?: string;
  rows: TaskRow[];
  loadFiles(id: string): Promise<TaskFiles>;
  artifacts?(id: string): Promise<CandidateArtifacts>;
  loadBundle?(key: string): Promise<TaskFiles>;
  readArtifact?(key: string, options?: { start?: number }): Promise<string>;
}

export interface ApiClient {
  json<T>(path: string): Promise<T>;
  text(path: string): Promise<string>;
  blob(path: string): Promise<Blob>;
}

export function createApiClient(token: string): ApiClient {
  const request = async (path: string): Promise<Response> => {
    const response = await fetch(
      path,
      token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    );
    if (!response.ok) {
      let detail = `${response.status}`;
      try {
        const body = (await response.json()) as { error?: string };
        if (body.error) detail = `${response.status} ${body.error}`;
      } catch {
        // keep the status code
      }
      throw new Error(`${path.split("?")[0]} failed (${detail})`);
    }
    return response;
  };
  return {
    json: async <T>(path: string) => (await request(path)).json() as Promise<T>,
    text: async (path: string) => (await request(path)).text(),
    blob: async (path: string) => (await request(path)).blob(),
  };
}
