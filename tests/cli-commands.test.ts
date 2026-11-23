import { afterEach, expect, test } from "bun:test";
import { cannedCli as cli, type Sent } from "./support/cli-replies.js";

// A developer's own `self-bench login` must not leak into these tests.
process.env.XDG_CONFIG_HOME = "/nonexistent/selfbench-test-config";
const environment = { ...process.env };
afterEach(() => {
  process.env = { ...environment };
});

const org = "/api/orgs/acme";
const repo = `${org}/repos/acme/app`;
const custom = `${org}/repos/evals/data-import-bugs`;
const replies = {
  [`GET ${org}/repos`]: {
    repos: [
      { kind: "github", fullName: "acme/app", private: true, agentMinutes: 30 },
      { kind: "eval", fullName: "evals/data-import-bugs", private: true, agentMinutes: 30 },
    ],
  },
  [`POST ${org}/evals`]: { repo: { kind: "eval", fullName: "evals/bugs" } },
  [`GET ${repo}/generation-options`]: { available: false },
  [`POST ${repo}/batches`]: { runId: "b-1" },
  [`POST ${repo}/tasks/from-pr`]: { task: { runId: "r", taskId: "t", state: "in_progress" } },
  [`POST ${repo}/tasks/from-scenario`]: { task: { runId: "r", taskId: "t", state: "in_progress" } },
  [`POST ${repo}/evaluations/batches`]: { id: "c", createdAt: "", runs: [] },
  [`GET ${repo}/evaluations`]: { runs: [] },
  [`GET ${org}/benchmarks/harbor/swe`]: { benchmark: { name: "harbor/swe" } },
  [`GET ${repo}/evaluations/summaries`]: { running: [] },
  [`GET ${repo}/evaluations/results`]: { tasks: 0, configurations: [], taskResults: [] },
};

/** What a command sent, without the fresh ids a batch makes up. */
async function requests(args: string[]): Promise<Sent[]> {
  const { sent } = await cli([...args, "--org", "acme"], replies);
  return sent.map(({ body, ...request }) => {
    if (!body || typeof body !== "object") return request;
    const { id: _id, ...rest } = body as Record<string, unknown>;
    return { ...request, body: rest };
  });
}

test("each command's older name sends what its new name sends", async () => {
  const pairs: [string[], string[]][] = [
    [["repos"], ["repo", "list"]],
    [
      ["eval", "create", "Bugs"],
      ["custom", "create", "Bugs"],
    ],
    [
      ["generate", "--repo", "acme/app", "--easy", "1"],
      ["batch", "create", "--repo", "acme/app", "--easy", "1"],
    ],
    [
      ["task", "add-pr", "--repo", "acme/app", "12"],
      ["task", "create", "--repo", "acme/app", "--pr", "12"],
    ],
    [
      ["scenario", "create", "--repo", "acme/app", "--title", "T", "--scenario", "Rows are lost."],
      ["task", "create", "--repo", "acme/app", "--title", "T", "--description", "Rows are lost."],
    ],
    [
      ["runs", "--repo", "acme/app"],
      ["evaluation", "list", "--repo", "acme/app"],
    ],
    [
      ["summaries", "--repo", "acme/app"],
      ["summary", "show", "--repo", "acme/app"],
    ],
    [
      ["benchmark", "show", "harbor/swe"],
      ["public", "show", "harbor/swe"],
    ],
  ];
  for (const [old, renamed] of pairs) {
    const sent = await requests(renamed);
    expect(sent.length).toBeGreaterThan(0);
    expect(await requests(old)).toEqual(sent);
  }
});

test("repo list shows repositories and custom list shows custom benchmarks", async () => {
  const names = async (args: string[]) =>
    ((await cli([...args, "--org", "acme"], replies)).printed.repos as { fullName: string }[]).map(
      (entry) => entry.fullName,
    );
  expect(await names(["repo", "list"])).toEqual(["acme/app"]);
  expect(await names(["custom", "list"])).toEqual(["evals/data-import-bugs"]);
});

test("feedback steers a task still generating, named by its page in the app", async () => {
  const task = `${custom}/tasks/r-1/t-1`;
  for (const page of [
    "https://app.selfbench.dev/custom/data-import-bugs/tasks/r-1/t-1",
    "https://app.selfbench.dev/repos/evals/data-import-bugs/tasks/r-1/t-1?tab=files",
  ]) {
    const { sent } = await cli(["feedback", page, "Keep", "the", "header.", "--org", "acme"], {
      [`GET ${task}`]: { task: { runId: "r-1", taskId: "t-1", pipelineStatus: "in_progress" } },
      [`POST ${task}/steering`]: { note: { id: "n-1" } },
    });
    expect(sent.at(-1)).toEqual({
      method: "POST",
      path: `${task}/steering`,
      body: { feedback: "Keep the header." },
    });
  }
});

test("feedback revises a finished task from its latest audit and prints the revision's page", async () => {
  const task = `${repo}/tasks/r-1/t-1`;
  const { sent, printed } = await cli(
    ["feedback", "acme/app", "r-1", "t-1", "Pin the version.", "--from-audit", "--org", "acme"],
    {
      [`GET ${task}`]: { task: { runId: "r-1", taskId: "t-1", pipelineStatus: "accepted" } },
      [`GET ${repo}/evaluations/audit?runId=r-1&taskId=t-1`]: {
        audit: { verdict: "unfair", text: "The tests need Node 24." },
      },
      [`GET ${repo}/generation-options`]: { available: false },
      [`POST ${task}/feedback`]: { task: { runId: "r-2", taskId: "t-1", state: "in_progress" } },
    },
  );
  const revised = sent.find((request) => request.path === `${task}/feedback`);
  const feedback = (revised?.body as { feedback?: string } | undefined)?.feedback;
  expect(feedback).toStartWith("Pin the version.\n\n");
  expect(feedback).toContain("The tests need Node 24.");
  expect(printed.url).toBe("http://selfbench.test/repos/acme/app/tasks/r-2/t-1");
});
