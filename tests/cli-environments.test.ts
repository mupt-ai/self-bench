import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/api/cli/main.js";
import type { ScenarioCandidate } from "../src/contracts/index.js";
import { createTaskStore } from "../src/db/tasks.js";
import { mint } from "./support/api-keys.js";
import { prFixture } from "./support/pr-fixture.js";
import type { AuthServer } from "./support/site-fixture.js";
import { gzippedTar, tarEntries } from "./support/tar.js";

let server: AuthServer | undefined;
let root: string | undefined;
// A developer's own `self-bench login` must not leak into these tests.
process.env.XDG_CONFIG_HOME = "/nonexistent/selfbench-test-config";
const environment = { ...process.env };
afterEach(async () => {
  await server?.stop();
  server = undefined;
  process.env = { ...environment };
  if (root) await rm(root, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<Record<string, unknown>> {
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runCli(args);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  } finally {
    log.mockRestore();
  }
}

test("the CLI creates, shows, and deletes an environment of every approved task", async () => {
  const fixture = await prFixture({});
  server = fixture.site;
  const { secret } = await mint(fixture.site, fixture.headers, { name: "CLI" });
  process.env.SELFBENCH_API_URL = fixture.site.origin;
  process.env.SELFBENCH_API_KEY = secret;
  await fixture.site.request("/api/orgs/mupt-ai/evals", {
    method: "POST",
    headers: fixture.headers,
    body: JSON.stringify({ name: "Data Import Bugs" }),
  });
  const repo = ["--repo", "evals/data-import-bugs", "--org", "mupt-ai"];
  const created = await cli([
    "scenario",
    "create",
    ...repo,
    "--title",
    "Import",
    "--scenario",
    "Rows are lost.",
  ]);
  const task = created.task as { runId: string; taskId: string };
  const candidate = fixture.started[0]?.input.candidate as ScenarioCandidate;
  const source = await fixture.artifacts.put(
    `runs/${task.runId}/authoring/${candidate.candidateId}/round-1/source-task.tar.gz`,
    await gzippedTar({ "instruction.md": "Fix it.", Dockerfile: "FROM node:22\n" }),
    "application/gzip",
  );
  await fixture.artifacts.put(
    `runs/${task.runId}/authoring/${candidate.candidateId}/round-1/result.json`,
    Buffer.from(
      JSON.stringify({
        kind: "submitted",
        task: { candidateId: candidate.candidateId, taskId: task.taskId, sourceBundle: source },
      }),
    ),
    "application/json",
  );
  await createTaskStore(fixture.site.db).settle(task.runId, candidate.candidateId, {
    stage: "accepted",
    pipelineStatus: "accepted",
    bundleKey: `runs/${task.runId}/harbor-task.tar.gz`,
  });
  await cli(["task", "approve", task.runId, task.taskId, ...repo]);
  root = await mkdtemp(join(tmpdir(), "selfbench-cli-environment-"));
  await writeFile(join(root, "claude.md"), "Read the bundled docs.");

  const started = await cli([
    "environment",
    "create",
    ...repo,
    "--name",
    "Docs, No AGENTS.md",
    "--package",
    "@scope/next@16.4.5",
    "--directory",
    "apps/web",
    "--file",
    `CLAUDE.md=${join(root, "claude.md")}`,
    "--delete",
    "AGENTS.md",
  ]);
  const made = started.environment as { id: number; name: string; changes: unknown };
  expect(made).toMatchObject({
    name: "Docs, No AGENTS.md",
    changes: {
      packages: [{ name: "@scope/next", spec: "16.4.5", directory: "apps/web" }],
      files: [
        { path: "CLAUDE.md", mode: "append", content: "Read the bundled docs." },
        { path: "AGENTS.md", mode: "delete", content: "" },
      ],
    },
  });
  const staged = fixture.started.at(-1)?.input.revision?.draft.sourceBundle ?? source;
  const dockerfile = (await tarEntries(Buffer.from(await fixture.artifacts.get(staged)))).find(
    (entry) => entry.path === "Dockerfile",
  )?.text;
  expect(dockerfile).toContain("'@scope/next@16.4.5'");
  expect(dockerfile).toContain("rm -rf -- /app/AGENTS.md");

  expect((await cli(["environments", ...repo])).environments).toMatchObject([
    { id: made.id, tasks: { checking: 1, total: 1 } },
  ]);
  expect((await cli(["environment", "show", String(made.id), ...repo])).tasks).toMatchObject([
    { task: { runId: task.runId, taskId: task.taskId }, state: "in_progress" },
  ]);
  expect(await cli(["environment", "delete", String(made.id), ...repo])).toEqual({ deleted: true });
  expect((await cli(["environments", ...repo])).environments).toEqual([]);
});
