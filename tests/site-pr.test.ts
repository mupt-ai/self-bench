import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts.js";
import { OAUTH_STATE_COOKIE } from "../src/auth/routes.js";
import { SESSION_COOKIE } from "../src/auth/session.js";
import { createMemoryUserStore } from "../src/auth/users.js";
import type { CandidateWorkflowInput } from "../src/contracts.js";
import { difficultyFor, parsePullRequestRef } from "../src/site/pr-candidate.js";
import { createMemoryRepoStore } from "../src/site/repo-store.js";
import { createMemoryTaskStore } from "../src/site/task-memory.js";
import { taskRunId } from "../src/site/task-start.js";
import type { WorkflowSnapshot } from "../src/site/task-status.js";
import {
  type AuthServer,
  cookieValue,
  fakeGitHub,
  startAuthServer,
  testAuthConfig,
} from "./support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const MERGE = "a".repeat(40);
const pullRequest = (number: number, extra: Record<string, unknown> = {}) => ({
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

async function boot(options: {
  pullRequests?: Record<number, Record<string, unknown>>;
  snapshots?: Record<string, WorkflowSnapshot>;
}) {
  const hub = fakeGitHub({
    orgs: ["Mupt-AI"],
    repos: [{ full_name: "Mupt-AI/self-bench" }],
    ...(options.pullRequests ? { pullRequests: options.pullRequests } : {}),
  });
  const logins = new Map([[1, "avyay"]]);
  const started: { workflowId: string; input: CandidateWorkflowInput }[] = [];
  const artifacts = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "site-pr-")));
  server = await startAuthServer({
    config: testAuthConfig,
    users: createMemoryUserStore(),
    repos: createMemoryRepoStore(logins),
    tasks: createMemoryTaskStore(logins),
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
  return { site: server, headers, started, artifacts };
}

const REPO = "/api/orgs/mupt-ai/repos/Mupt-AI/self-bench";

describe("add a PR", () => {
  test("parses PR references and difficulty tiers", () => {
    expect(parsePullRequestRef("46", "a/b")).toBe(46);
    expect(parsePullRequestRef("#46", "a/b")).toBe(46);
    expect(parsePullRequestRef("https://github.com/A/B/pull/46", "a/b")).toBe(46);
    expect(parsePullRequestRef("https://github.com/A/B/pull/46/files", "a/b")).toBe(46);
    expect(parsePullRequestRef("https://github.com/x/y/pull/46", "a/b")).toBeUndefined();
    expect(parsePullRequestRef("nope", "a/b")).toBeUndefined();
    expect(difficultyFor(19, 1)).toBeUndefined();
    expect(difficultyFor(20, 1)).toBe("easy");
    expect(difficultyFor(60, 1)).toBe("easy");
    expect(difficultyFor(60, 2)).toBe("medium");
    expect(difficultyFor(110, 3)).toBe("hard");
    expect(taskRunId("Mupt-AI/self-bench", 46, 1)).toBe("pr-mupt-ai-self-bench-46");
    expect(taskRunId("Mupt-AI/self-bench", 46, 2)).toBe("pr-mupt-ai-self-bench-46-a2");
  });

  test("starts one candidate workflow for a merged PR and records the task", async () => {
    const { site, headers, started, artifacts } = await boot({
      pullRequests: { 46: pullRequest(46) },
    });
    const response = await site.request(`${REPO}/tasks/from-pr`, {
      method: "POST",
      headers,
      body: JSON.stringify({ pr: "https://github.com/Mupt-AI/self-bench/pull/46" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      task: {
        runId: "pr-mupt-ai-self-bench-46",
        candidateId: "self-bench-pr-46",
        difficulty: "hard",
        state: "in_progress",
        stage: "authoring",
        sourcePr: 46,
        workflowId: "pr-mupt-ai-self-bench-46/candidate/self-bench-pr-46",
        startedBy: "avyay",
      },
    });
    expect(started).toHaveLength(1);
    const input = started[0]?.input;
    expect(input?.run).toMatchObject({
      runId: "pr-mupt-ai-self-bench-46",
      repository: { url: "https://github.com/Mupt-AI/self-bench", commit: MERGE },
      candidateCounts: { easy: 0, medium: 0, hard: 1 },
      authoring: { provider: "openai-codex" },
    });
    expect(input?.candidate).toMatchObject({
      candidateId: "self-bench-pr-46",
      baseCommit: "b".repeat(40),
      completedCommit: MERGE,
      request: "Fix thing 46\n\nDetails of the fix.",
    });
    const staged = await artifacts.getByKey(
      "runs/pr-mupt-ai-self-bench-46/provenance/self-bench-pr-46.json",
    );
    expect(JSON.parse(Buffer.from(staged ?? []).toString("utf8"))).toMatchObject({
      source: { sourceType: "github-pull-request", sourcePr: 46 },
      messages: [{ role: "user" }],
    });

    const again = await site.request(`${REPO}/tasks/from-pr`, {
      method: "POST",
      headers,
      body: JSON.stringify({ pr: 46 }),
    });
    expect(await again.json()).toMatchObject({ task: { runId: "pr-mupt-ai-self-bench-46-a2" } });
  });

  test("refuses PRs that are unmerged, too small, missing, or malformed", async () => {
    const { site, headers, started } = await boot({
      pullRequests: {
        1: pullRequest(1, { merged: false }),
        2: pullRequest(2, { additions: 5, deletions: 5 }),
        3: pullRequest(3, { user: { login: "dependabot", type: "Bot" } }),
      },
    });
    const post = (pr: unknown) =>
      site.request(`${REPO}/tasks/from-pr`, {
        method: "POST",
        headers,
        body: JSON.stringify({ pr }),
      });
    expect((await post(1)).status).toBe(422);
    expect((await post(2)).status).toBe(422);
    expect((await post(3)).status).toBe(422);
    expect((await post(999)).status).toBe(404);
    expect((await post("what")).status).toBe(400);
    expect(started).toHaveLength(0);
  });

  test("listing tasks refreshes in-progress rows from their workflows", async () => {
    const workflowId = "pr-mupt-ai-self-bench-46/candidate/self-bench-pr-46";
    const snapshots: Record<string, WorkflowSnapshot> = {
      [workflowId]: {
        kind: "running",
        progress: {
          candidateId: "self-bench-pr-46",
          taskId: "self-bench-pr-46",
          difficulty: "hard",
          status: "verifying",
          stage: "verification",
          round: 2,
        },
      },
    };
    const { site, headers } = await boot({ pullRequests: { 46: pullRequest(46) }, snapshots });
    await site.request(`${REPO}/tasks/from-pr`, {
      method: "POST",
      headers,
      body: JSON.stringify({ pr: 46 }),
    });
    const running = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: { stage: string; round?: number; state: string }[];
    };
    expect(running.tasks[0]).toMatchObject({
      stage: "verification",
      round: 2,
      state: "in_progress",
    });

    snapshots[workflowId] = {
      kind: "completed",
      result: {
        progress: {
          candidateId: "self-bench-pr-46",
          taskId: "self-bench-pr-46",
          difficulty: "hard",
          status: "rejected",
          stage: "verification",
          round: 3,
          reason: "verifier: tests pass without the fix",
        },
      },
    };
    const done = (await (await site.request(`${REPO}/tasks`, { headers })).json()) as {
      tasks: { state: string; reasonSummary?: string }[];
    };
    expect(done.tasks[0]).toMatchObject({
      state: "rejected",
      reasonSummary: "verifier: tests pass without the fix",
    });
  });
});
