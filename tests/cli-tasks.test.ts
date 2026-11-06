import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generationFromFlags } from "../src/api/cli/generation.js";
import { runCli } from "../src/api/cli/main.js";
import type { ScenarioCandidate } from "../src/contracts/index.js";
import { createTaskStore } from "../src/db/tasks.js";
import { mint } from "./support/api-keys.js";
import { prFixture } from "./support/pr-fixture.js";
import type { AuthServer } from "./support/site-fixture.js";
import { gzippedTar, tarEntries } from "./support/tar.js";

let server: AuthServer | undefined;
const roots: string[] = [];
// A developer's own `self-bench login` must not leak into these tests.
process.env.XDG_CONFIG_HOME = "/nonexistent/selfbench-test-config";
const environment = { ...process.env };
afterEach(async () => {
  await server?.stop();
  server = undefined;
  process.env = { ...environment };
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-cli-"));
  roots.push(root);
  return root;
}

/** Runs the CLI against the fixture as the key's owner, returning what it printed. */
async function cli(args: string[]): Promise<Record<string, unknown>> {
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runCli(args);
    return JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  } finally {
    log.mockRestore();
  }
}

test("the CLI creates a scenario, pulls its draft, and revises it from an edited copy", async () => {
  const fixture = await prFixture({});
  server = fixture.site;
  const { secret } = await mint(fixture.site, fixture.headers, { name: "CLI" });
  process.env.SELFBENCH_API_URL = fixture.site.origin;
  process.env.SELFBENCH_API_KEY = secret;
  process.env.SELFBENCH_API_TOKEN = "operator-token-that-api-routes-must-not-use";
  const files = await directory();
  await writeFile(join(files, "scenario.md"), "An email traded me to team 3.");
  await writeFile(join(files, "schedule.csv"), "team,date\n6,Mon\n");
  // A workspace scenario belongs to an eval, which the CLI names like a repository.
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
    "Traded",
    "--scenario-file",
    join(files, "scenario.md"),
    "--attach",
    join(files, "schedule.csv"),
  ]);
  const task = created.task as { runId: string; taskId: string; title: string };
  expect(task.title).toBe("Traded");
  const candidate = fixture.started[0]?.input.candidate as ScenarioCandidate;
  expect(candidate.request).toBe("An email traded me to team 3.");
  if (!candidate.attachments) throw new Error("no attachments");
  expect(await tarEntries(Buffer.from(await fixture.artifacts.get(candidate.attachments)))).toEqual(
    [expect.objectContaining({ path: "schedule.csv", text: "team,date\n6,Mon\n" })],
  );
  // This fixture stores no credentials, so the CLI sends no generation settings.
  expect(fixture.started[0]?.input.run.generation).toBeUndefined();

  const source = await fixture.artifacts.put(
    `runs/${task.runId}/authoring/${candidate.candidateId}/round-1/source-task.tar.gz`,
    await gzippedTar({ "instruction.md": "When is my next game?", "workspace/a.txt": "6" }),
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
  });

  const listed = await cli(["tasks", ...repo]);
  expect(listed.tasks).toEqual([expect.objectContaining({ taskId: task.taskId })]);
  const pulled = join(await directory(), "draft");
  await cli(["task", "pull", task.runId, task.taskId, pulled, ...repo]);
  expect(await readFile(join(pulled, "workspace/a.txt"), "utf8")).toBe("6");
  await writeFile(join(pulled, "instruction.md"), "When and where is my next game?");

  await cli([
    "task",
    "revise",
    task.runId,
    task.taskId,
    ...repo,
    "--feedback",
    "Ask for the venue.",
    "--draft",
    pulled,
  ]);
  const revision = fixture.started[1]?.input.revision;
  expect(revision?.feedback).toBe("Ask for the venue.");
  const sent = await tarEntries(
    Buffer.from(await fixture.artifacts.get(revision?.draft.sourceBundle ?? source)),
  );
  expect(sent).toContainEqual(
    expect.objectContaining({ path: "instruction.md", text: "When and where is my next game?" }),
  );
  expect(sent).toContainEqual(expect.objectContaining({ path: "workspace/a.txt", text: "6" }));

  const approved = await cli(["task", "approve", task.runId, task.taskId, ...repo, "--note", "ok"]);
  expect(approved.task).toMatchObject({ review: { decision: "approve", note: "ok" } });
});

test("generation flags default to the app's managed settings", () => {
  expect(generationFromFlags({})).toEqual({
    authorModel: "gpt-6.1-sol",
    verifierModel: "gpt-6.1-sol",
    reasoning: "high",
    modelAccess: "managed",
    sandbox: "managed",
  });
  expect(
    generationFromFlags({
      model: "claude-fable-5",
      "model-credential": "c",
      sandbox: "modal",
      "sandbox-credential": "s",
    }),
  ).toMatchObject({
    authorModel: "claude-fable-5",
    verifierModel: "claude-fable-5",
    modelAccess: "credential",
    modelCredentialId: "c",
    sandbox: "modal",
    sandboxCredentialId: "s",
  });
});
