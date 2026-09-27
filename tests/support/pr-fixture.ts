import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import type { CandidateWorkflowInput } from "../../src/contracts/index.js";
import type { Vault } from "../../src/db/vault.js";
import type { WorkflowSnapshot } from "../../src/generation/tasks/status.js";
import { connectRepo, signedIn } from "./sign-in.js";
import { fakeGitHub, startAuthServer, testAuthConfig } from "./site-fixture.js";
export const MERGE = "a".repeat(40);
export const pullRequest = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  merged: true,
  merge_commit_sha: MERGE,
  title: `Fix thing ${number}`,
  body: "Details of the fix.",
  additions: 80,
  deletions: 30,
  changed_files: 3,
  html_url: `https://github.com/Mupt-AI/self-bench/pull/${number}`,
  user: { login: "someone", type: "User" },
  ...extra,
});

export async function prFixture(options: {
  vault?: Vault;
  pullRequests?: Record<number, Record<string, unknown>>;
  snapshots?: Record<string, WorkflowSnapshot>;
}) {
  const hub = fakeGitHub({
    orgs: ["Mupt-AI"],
    repos: [{ full_name: "Mupt-AI/self-bench" }],
    ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
  });
  const started: { workflowId: string; input: CandidateWorkflowInput }[] = [];
  const artifacts = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "site-pr-")));
  const server = await startAuthServer({
    ...(options.vault ? { vault: options.vault } : {}),
    config: testAuthConfig,
    artifacts,
    fetchImpl: hub.fetch,
    start: async (workflowId, input) => {
      started.push({ workflowId, input });
    },
    status: {
      async snapshot(workflowId) {
        return options.snapshots?.[workflowId] ?? { kind: "unknown" };
      },
    },
  });
  const headers = await signedIn(server);
  await connectRepo(server, headers);
  return { site: server, headers, started, artifacts, hub };
}

export const REPO = "/api/orgs/mupt-ai/repos/Mupt-AI/self-bench";
