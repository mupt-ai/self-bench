import { randomBytes } from "node:crypto";
import type { ArtifactStore } from "../../artifacts/index.js";
import { renderPrompt } from "./prompts.js";

/**
 * Steering: notes a person sends a task's author while it is still being generated. They wait in
 * the artifact store and reach the author at the start of its next authoring turn, which follows
 * each `verify`, a failed submission, or a reviewer's suggestions. A note sent after the last
 * authoring turn is never delivered, and stays listed as pending.
 */
export interface SteeringNote {
  readonly id: string;
  readonly feedback: string;
  readonly author?: string;
  readonly createdAt: string;
  /** The turn that received it; absent while it waits. */
  readonly delivered?: { readonly round: number; readonly turn: number };
}

export interface SteeringTask {
  readonly runId: string;
  readonly candidateId: string;
}

const root = ({ runId, candidateId }: SteeringTask) => `runs/${runId}/steering/${candidateId}`;
// Folders, listed without a trailing slash as the stores expect.
const notesPrefix = (task: SteeringTask) => `${root(task)}/notes`;
const deliveriesPrefix = (task: SteeringTask) => `${root(task)}/delivered`;
const deliveryKey = (task: SteeringTask, round: number, turn: number) =>
  `${deliveriesPrefix(task)}/r${round}-t${turn}.json`;

const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const parse = <T>(bytes: Uint8Array): T => JSON.parse(Buffer.from(bytes).toString("utf8")) as T;

/** Notes this process has queued, which orders those sent in the same millisecond. */
let sent = 0;

/** Queues a note for the task's next authoring turn. */
export async function addSteeringNote(
  store: ArtifactStore,
  task: SteeringTask,
  note: { readonly feedback: string; readonly author?: string },
  now = new Date(),
): Promise<SteeringNote> {
  // Sortable by time, then by the order this process sent them, so two notes in one millisecond
  // keep their order; the random suffix keeps notes from two processes apart.
  sent += 1;
  const order = String(sent % 1_000_000).padStart(6, "0");
  const id = `${now.toISOString().replace(/[:.]/g, "-")}-${order}-${randomBytes(4).toString("hex")}`;
  const saved = {
    id,
    feedback: note.feedback,
    ...(note.author ? { author: note.author } : {}),
    createdAt: now.toISOString(),
  };
  await store.put(`${notesPrefix(task)}/${id}.json`, json(saved), "application/json");
  return saved;
}

/** One authoring turn's claim: the notes it received. Each note is claimed by one turn only. */
interface Delivery {
  readonly round: number;
  readonly turn: number;
  readonly notes: readonly string[];
}

async function readAll<T extends object>(store: ArtifactStore, prefix: string): Promise<T[]> {
  const entries = (await store.list(prefix)).filter((entry) => entry.key.endsWith(".json"));
  const found: (T | undefined)[] = await Promise.all(
    entries.map(async (entry) => {
      const bytes = await store.getByKey(entry.key);
      return bytes ? parse<T>(bytes) : undefined;
    }),
  );
  return found.filter((value): value is T => value !== undefined);
}

/** Every note sent to the task, oldest first, with the turn that received each. */
export async function listSteeringNotes(
  store: ArtifactStore,
  task: SteeringTask,
): Promise<SteeringNote[]> {
  const [notes, deliveries] = await Promise.all([
    readAll<SteeringNote>(store, notesPrefix(task)),
    readAll<Delivery>(store, deliveriesPrefix(task)),
  ]);
  const deliveredIn = new Map<string, { round: number; turn: number }>();
  for (const { round, turn, notes: ids } of deliveries) {
    for (const id of ids) deliveredIn.set(id, { round, turn });
  }
  return notes
    .map((note) => {
      const delivered = deliveredIn.get(note.id);
      return delivered ? { ...note, delivered } : note;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The notes for one authoring turn: those no earlier turn received. The claim is recorded, so a
 * retried attempt of the same turn gets the same notes rather than none.
 */
export async function claimSteeringNotes(
  store: ArtifactStore,
  task: SteeringTask,
  round: number,
  turn: number,
): Promise<SteeringNote[]> {
  const notes = await listSteeringNotes(store, task);
  const claimedBefore = notes.filter(
    (note) => note.delivered?.round === round && note.delivered.turn === turn,
  );
  if (claimedBefore.length > 0) return claimedBefore;
  const pending = notes.filter((note) => !note.delivered);
  if (pending.length === 0) return [];
  const delivery: Delivery = { round, turn, notes: pending.map((note) => note.id) };
  await store.put(deliveryKey(task, round, turn), json(delivery), "application/json");
  return pending;
}

/**
 * The turn's message, with the notes it claims after it. Notes are listed as a block the author
 * reads once; a turn with none gets the message unchanged.
 */
export async function withSteeringNotes(
  store: ArtifactStore,
  { round, turn, ...task }: SteeringTask & { readonly round: number; readonly turn: number },
  message: string,
): Promise<string> {
  const notes = await claimSteeringNotes(store, task, round, turn);
  if (notes.length === 0) return message;
  const body = notes
    .map(
      (note) =>
        `[${note.createdAt}${note.author ? `, ${note.author}` : ""}]\n${note.feedback.trim()}`,
    )
    .join("\n\n");
  return `${message.trimEnd()}\n\n${renderPrompt("steering", { notes: body })}`;
}
