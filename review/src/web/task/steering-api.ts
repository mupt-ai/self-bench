import type { SteeringNote } from "../../../../src/generation/pipeline/steering";
import { repoPath, requestJson } from "../api";

export type { SteeringNote };

type TaskRef = { runId: string; taskId: string };

const steeringPath = (org: string, fullName: string, task: TaskRef) =>
  `${repoPath(org, fullName)}/tasks/${encodeURIComponent(task.runId)}/${encodeURIComponent(task.taskId)}/steering`;

export async function getSteeringNotes(
  org: string,
  fullName: string,
  task: TaskRef,
): Promise<SteeringNote[]> {
  return (await requestJson<{ notes: SteeringNote[] }>(steeringPath(org, fullName, task))).notes;
}

/** Queues a note for the author's next turn. */
export async function sendSteeringNote(
  org: string,
  fullName: string,
  task: TaskRef,
  feedback: string,
): Promise<SteeringNote> {
  const body = await requestJson<{ note: SteeringNote }>(steeringPath(org, fullName, task), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feedback }),
  });
  return body.note;
}
