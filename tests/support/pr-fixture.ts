import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_COOKIE } from "../../src/api/auth/session.js";
import { OAUTH_STATE_COOKIE } from "../../src/api/routes/auth.js";
import { LocalArtifactStore } from "../../src/artifacts/index.js";
import type { CandidateWorkflowInput } from "../../src/contracts/index.js";
import type { Vault } from "../../src/db/vault.js";
import type { WorkflowSnapshot } from "../../src/generation/tasks/status.js";
import { cookieValue, fakeGitHub, startAuthServer, testAuthConfig } from "./site-fixture.js";
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
  const start = await server.request("/auth/github");
  const state = cookieValue(start, OAUTH_STATE_COOKIE) ?? "";
  const callback = await server.request(`/auth/github/callback?code=c&state=${state}`, {
    headers: { cookie: `${OAUTH_STATE_COOKIE}=${state}` },
  });
  const headers = {
    cookie: `${SESSION_COOKIE}=${cookieValue(callback, SESSION_COOKIE) ?? ""}`,
    "content-type": "application/json",
  };
  await server.request("/api/orgs/mupt-ai/repos", {
    method: "POST",
    headers,
    body: JSON.stringify({ fullName: "Mupt-AI/self-bench" }),
  });
  return { site: server, headers, started, artifacts, hub };
}

export const REPO = "/api/orgs/mupt-ai/repos/Mupt-AI/self-bench";
