import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/local.js";
import { createTaskStore } from "../../src/db/tasks.js";
import {
  addSteeringNote,
  claimSteeringNotes,
  listSteeringNotes,
  withSteeringNotes,
} from "../../src/generation/pipeline/steering.js";
import { prFixture, pullRequest, REPO } from "../support/pr-fixture.js";
import type { AuthServer } from "../support/site-fixture.js";

const task = { runId: "run-steer", candidateId: "cand-1" };

async function store() {
  return new LocalArtifactStore(await mkdtemp(join(tmpdir(), "selfbench-steering-")));
}

test("each note reaches exactly one authoring turn, and a retried turn gets the same notes", async () => {
  const artifacts = await store();
  expect(await claimSteeringNotes(artifacts, task, 1, 1)).toEqual([]);
  const first = await addSteeringNote(artifacts, task, {
    feedback: "Use 'use cache'.",
    author: "avyay",
  });
  const second = await addSteeringNote(artifacts, task, { feedback: "Test reuse." });

  const turn2 = await claimSteeringNotes(artifacts, task, 1, 2);
  expect(turn2.map((note) => note.id)).toEqual([first.id, second.id]);
  // A retry of turn 2 replays its notes; a note sent since waits for turn 3.
  const third = await addSteeringNote(artifacts, task, { feedback: "And invalidation." });
  expect((await claimSteeringNotes(artifacts, task, 1, 2)).map((note) => note.id)).toEqual([
    first.id,
    second.id,
  ]);
  expect((await claimSteeringNotes(artifacts, task, 1, 3)).map((note) => note.id)).toEqual([
    third.id,
  ]);
  expect(await claimSteeringNotes(artifacts, task, 2, 1)).toEqual([]);

  const listed = await listSteeringNotes(artifacts, task);
  expect(listed.map((note) => [note.feedback, note.delivered])).toEqual([
    ["Use 'use cache'.", { round: 1, turn: 2 }],
    ["Test reuse.", { round: 1, turn: 2 }],
    ["And invalidation.", { round: 1, turn: 3 }],
  ]);
  // Another candidate's notes stay apart.
  expect(await listSteeringNotes(artifacts, { ...task, candidateId: "cand-2" })).toEqual([]);
});

test("a turn's message carries the notes it claims, with who sent them", async () => {
  const artifacts = await store();
  const turn = { ...task, round: 1, turn: 2 };
  expect(await withSteeringNotes(artifacts, turn, "Verify report\n")).toBe("Verify report\n");
  await addSteeringNote(
    artifacts,
    task,
    { feedback: "  Cache the event data.  ", author: "avyay" },
    new Date("2026-11-06T20:00:00.000Z"),
  );
  const steered = await withSteeringNotes(artifacts, { ...turn, turn: 3 }, "Verify report\n");
  expect(steered).toStartWith("Verify report\n\n");
  expect(steered).toContain("# Notes from the Person Watching This Task");
  expect(steered).toContain("[2026-11-06T20:00:00.000Z, avyay]\nCache the event data.");
  // The next turn gets nothing new: the note is already claimed.
  expect(await withSteeringNotes(artifacts, { ...turn, turn: 4 }, "Verify report\n")).toBe(
    "Verify report\n",
  );
});

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

test("notes can be sent to a task only while it generates, and are listed with their turn", async () => {
  const { site, headers, artifacts } = await prFixture({ pullRequests: { 57: pullRequest(57) } });
  server = site;
  const started = await site.request(`${REPO}/tasks/from-pr`, {
    method: "POST",
    headers,
    body: JSON.stringify({ pr: 57 }),
  });
  const created = (await started.json()).task as {
    runId: string;
    taskId: string;
    candidateId: string;
  };
  const path = `${REPO}/tasks/${created.runId}/${created.taskId}/steering`;

  expect((await site.request(path, { method: "POST", headers, body: "{}" })).status).toBe(400);
  const sent = await site.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ feedback: "Require 'use cache'." }),
  });
  expect(sent.status).toBe(201);
  const { note } = (await sent.json()) as { note: { id: string; author?: string } };
  expect(note.author).toBeString();

  await claimSteeringNotes(artifacts, created, 1, 2);
  const listed = await site.request(path, { headers });
  expect(listed.status).toBe(200);
  expect((await listed.json()).notes).toMatchObject([
    { id: note.id, feedback: "Require 'use cache'.", delivered: { round: 1, turn: 2 } },
  ]);

  await createTaskStore(site.db).settle(created.runId, created.candidateId, {
    stage: "accepted",
    pipelineStatus: "accepted",
  });
  const late = await site.request(path, {
    method: "POST",
    headers,
    body: JSON.stringify({ feedback: "Too late." }),
  });
  expect(late.status).toBe(409);
});
