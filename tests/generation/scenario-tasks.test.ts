import { afterEach, expect, test } from "bun:test";
import type { ScenarioCandidate } from "../../src/contracts/index.js";
import { createTaskStore } from "../../src/db/tasks.js";
import { mint } from "../support/api-keys.js";
import { prFixture, REPO } from "../support/pr-fixture.js";
import type { AuthServer } from "../support/site-fixture.js";
import { gzippedTar, tarEntries } from "../support/tar.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function boot() {
  const result = await prFixture({});
  server = result.site;
  const { secret } = await mint(result.site, result.headers, { name: "CLI" });
  return { ...result, key: { authorization: `Bearer ${secret}` } };
}

const SCENARIO = {
  title: "Traded to a New Team",
  scenario:
    "My rec league schedule spreadsheet says I'm on team 6. Last week an email said I was traded to team 3. Asked when my next game is, my agent answered from the spreadsheet.",
  difficulty: "hard",
  attachments: [
    { name: "schedule.csv", content: Buffer.from("team,date\n6,Mon").toString("base64") },
  ],
};

test("an API key starts a scenario task with its attachments, and no GitHub read", async () => {
  const { site, key, started, artifacts, hub } = await boot();
  const before = hub.calls.length;
  const response = await site.request(`${REPO}/tasks/from-scenario`, {
    method: "POST",
    headers: key,
    body: JSON.stringify(SCENARIO),
  });
  expect(response.status).toBe(201);
  const { task } = (await response.json()) as {
    task: { runId: string; taskId: string; title: string; sourcePr?: number; state: string };
  };
  expect(task).toMatchObject({
    taskId: "scenario-traded-to-a-new-team",
    title: "Traded to a New Team",
    state: "in_progress",
  });
  expect(task.sourcePr).toBeUndefined();
  expect(task.runId).toStartWith("scn-mupt-ai-self-bench-");
  expect(hub.calls.slice(before)).toEqual([]);

  expect(started).toHaveLength(1);
  const input = started[0]?.input;
  const candidate = input?.candidate as ScenarioCandidate;
  expect(candidate).toMatchObject({
    kind: "scenario",
    title: "Traded to a New Team",
    difficulty: "hard",
    request: SCENARIO.scenario,
  });
  expect(started[0]?.workflowId).toBe(`${task.runId}/candidate/${candidate.candidateId}`);
  if (!candidate.attachments) throw new Error("attachments were not staged");
  const files = await tarEntries(Buffer.from(await artifacts.get(candidate.attachments)));
  expect(files).toEqual([
    expect.objectContaining({ path: "schedule.csv", text: "team,date\n6,Mon" }),
  ]);
  const provenance = JSON.parse(
    Buffer.from(await artifacts.get(candidate.provenance)).toString("utf8"),
  );
  expect(provenance.messages).toEqual([{ role: "user", content: SCENARIO.scenario }]);
});

test("a scenario must be described, and its attachments plainly named and unique", async () => {
  const { site, key, started } = await boot();
  const post = (body: object) =>
    site.request(`${REPO}/tasks/from-scenario`, {
      method: "POST",
      headers: key,
      body: JSON.stringify({ ...SCENARIO, ...body }),
    });
  expect((await post({ scenario: " " })).status).toBe(400);
  expect((await post({ difficulty: "impossible" })).status).toBe(400);
  const traversal = await post({ attachments: [{ name: "../escape", content: "eA==" }] });
  expect(traversal.status).toBe(400);
  expect((await traversal.json()).error).toContain("attachments");
  const twice = [SCENARIO.attachments[0], SCENARIO.attachments[0]];
  expect((await post({ attachments: twice })).status).toBe(400);
  expect(started).toHaveLength(0);
});

test("a person edits a scenario task's draft and revises it with the edit", async () => {
  const { site, key, started, artifacts } = await boot();
  const created = await site.request(`${REPO}/tasks/from-scenario`, {
    method: "POST",
    headers: key,
    body: JSON.stringify(SCENARIO),
  });
  const original = (await created.json()).task as { runId: string; taskId: string };
  const path = `${REPO}/tasks/${original.runId}/${original.taskId}`;
  expect((await site.request(`${path}/draft`, { headers: key })).status).toBe(404);

  const candidate = started[0]?.input.candidate as ScenarioCandidate;
  const submitted = await gzippedTar({
    "instruction.md": "When is my next game? Write /app/answer.json.",
    "workspace/schedule.csv": "team,date\n6,Mon",
  });
  const source = await artifacts.put(
    `runs/${original.runId}/authoring/${candidate.candidateId}/round-1/source-task.tar.gz`,
    submitted,
    "application/gzip",
  );
  await artifacts.put(
    `runs/${original.runId}/authoring/${candidate.candidateId}/round-1/result.json`,
    Buffer.from(
      JSON.stringify({
        kind: "submitted",
        task: { candidateId: candidate.candidateId, taskId: original.taskId, sourceBundle: source },
      }),
    ),
    "application/json",
  );
  const store = createTaskStore(site.db);
  await store.settle(original.runId, candidate.candidateId, {
    stage: "accepted",
    pipelineStatus: "accepted",
  });

  const draft = await site.request(`${path}/draft`, { headers: key });
  expect(draft.status).toBe(200);
  expect(draft.headers.get("x-content-sha256")).toBe(source.sha256);
  expect(Buffer.from(await draft.arrayBuffer()).equals(submitted)).toBe(true);

  const feedback = (body: object) =>
    site.request(`${path}/feedback`, { method: "POST", headers: key, body: JSON.stringify(body) });
  const smuggled = await gzippedTar({ "instruction.md": "x", "secrets.env": "TOKEN=1" });
  const refused = await feedback({
    feedback: "Use team 3.",
    draft: smuggled.toString("base64"),
  });
  expect(refused.status).toBe(400);
  expect((await refused.json()).error).toContain("secrets.env");

  const edited = await gzippedTar({
    "instruction.md": "When and where is my next game? Write /app/answer.json.",
    "workspace/schedule.csv": "team,date\n6,Mon\n3,Tue",
  });
  const revised = await feedback({
    feedback: "Ask for the venue too.",
    draft: edited.toString("base64"),
  });
  expect(revised.status).toBe(201);
  const revision = (await revised.json()).task as { runId: string; title: string };
  expect(revision.title).toBe("Traded to a New Team");
  expect(revision.runId).not.toBe(original.runId);
  expect(started).toHaveLength(2);
  const restarted = started[1]?.input;
  expect(restarted?.candidate).toMatchObject({
    kind: "scenario",
    candidateId: candidate.candidateId,
    request: SCENARIO.scenario,
    difficulty: "hard",
  });
  const carried = (restarted?.candidate as ScenarioCandidate | undefined)?.attachments;
  expect(carried?.sha256).toBe(candidate.attachments?.sha256);
  expect(carried?.uri).toContain(revision.runId);
  expect(restarted?.revision?.feedback).toBe("Ask for the venue too.");
  const startingDraft = restarted?.revision?.draft.sourceBundle;
  if (!startingDraft) throw new Error("revision has no draft");
  expect(Buffer.from(await artifacts.get(startingDraft)).equals(edited)).toBe(true);
  expect(startingDraft.uri).toContain(revision.runId);
});
