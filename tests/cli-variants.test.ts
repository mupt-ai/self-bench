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

test("the CLI creates, lists, and deletes a task's variants", async () => {
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
  const store = createTaskStore(fixture.site.db);
  await store.settle(task.runId, candidate.candidateId, {
    stage: "accepted",
    pipelineStatus: "accepted",
  });
  root = await mkdtemp(join(tmpdir(), "selfbench-cli-variant-"));
  await writeFile(join(root, "agents.md"), "Read the bundled docs.");

  const ids = [task.runId, task.taskId];
  const started = await cli([
    "task",
    "variant",
    "create",
    ...ids,
    ...repo,
    "--label",
    "Docs",
    "--package",
    "@scope/next@16.4.5",
    "--directory",
    "apps/web",
    "--file",
    `AGENTS.md=${join(root, "agents.md")}`,
  ]);
  const variant = started.variant as { runId: string; label: string; changes: unknown };
  expect(variant).toMatchObject({
    label: "Docs",
    changes: {
      packages: [{ name: "@scope/next", spec: "16.4.5", directory: "apps/web" }],
      files: [{ path: "AGENTS.md", mode: "append", content: "Read the bundled docs." }],
    },
  });
  const dockerfile = (
    await tarEntries(
      Buffer.from(
        await fixture.artifacts.get(
          fixture.started.at(-1)?.input.revision?.draft.sourceBundle ?? source,
        ),
      ),
    )
  ).find((entry) => entry.path === "Dockerfile")?.text;
  expect(dockerfile).toContain("'@scope/next@16.4.5'");

  expect((await cli(["task", "variant", "list", ...ids, ...repo])).variants).toMatchObject([
    { runId: variant.runId, state: "in_progress" },
  ]);
  await store.variants.settle(variant.runId, candidate.candidateId, {
    pipelineStatus: "rejected",
    stage: "verifying",
    reason: "The tests failed.",
  });
  expect(await cli(["task", "variant", "delete", ...ids, variant.runId, ...repo])).toEqual({
    deleted: true,
  });
  expect((await cli(["task", "variant", "list", ...ids, ...repo])).variants).toEqual([]);
});
