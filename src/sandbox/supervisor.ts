import type { LiveSandbox } from "./contracts.js";

export const MAILBOX_DIRECTORY = "/work/mailbox";
export const MAILBOX_REQUESTS = `${MAILBOX_DIRECTORY}/requests`;
export const MAILBOX_RESPONSES = `${MAILBOX_DIRECTORY}/responses`;
export const MAILBOX_DONE = `${MAILBOX_DIRECTORY}/done`;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

export interface MailboxRequest {
  readonly id: string;
  readonly kind: "task" | "fix";
  readonly definition: unknown;
  readonly testPatch: string;
  readonly goldPatch?: string;
}

export type MailboxResponse =
  | {
      readonly id: string;
      readonly kind: "report";
      readonly green: boolean;
      readonly summary: string;
      readonly rendered: string;
    }
  | { readonly id: string; readonly kind: "error"; readonly message: string };

export interface SuperviseOptions {
  readonly handle: (request: MailboxRequest) => Promise<MailboxResponse>;
  /** Errors that must stop supervision and fail the run (e.g. Temporal cancellation). */
  readonly isFatal?: (error: unknown) => boolean;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly onPoll?: (error?: unknown) => void;
}

export interface SupervisionSummary {
  readonly handled: number;
  readonly stoppedBy: "done" | "exited";
}

/**
 * Worker side of the sandbox mailbox: polls the live sandbox for verify requests written by the
 * agent's `verify` tool, runs the handler, and writes the response the tool is blocking on. Stops
 * when the wrapper writes the done marker or the command exits.
 */
export async function superviseMailbox(
  sandbox: LiveSandbox,
  exited: AbortSignal,
  options: SuperviseOptions,
): Promise<SupervisionSummary> {
  const seen = new Set<string>();
  const sleep = options.sleep ?? abortableSleep;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let handled = 0;
  while (true) {
    let done = false;
    try {
      for (const id of await listRequests(sandbox)) {
        if (seen.has(id) || exited.aborted) {
          continue;
        }
        seen.add(id);
        const bytes = await sandbox.readFile(`${MAILBOX_REQUESTS}/${id}.json`);
        if (!bytes) {
          continue;
        }
        const response = await respond(id, bytes, options);
        handled += 1;
        await writeResponse(sandbox, response);
      }
      done = (await sandbox.readFile(MAILBOX_DONE)) !== undefined;
      options.onPoll?.();
    } catch (error) {
      if (options.isFatal?.(error)) {
        throw error;
      }
      options.onPoll?.(error);
    }
    if (done) {
      return { handled, stoppedBy: "done" };
    }
    if (exited.aborted) {
      return { handled, stoppedBy: "exited" };
    }
    await sleep(interval, exited);
  }
}

async function respond(
  id: string,
  bytes: Uint8Array,
  options: SuperviseOptions,
): Promise<MailboxResponse> {
  let request: MailboxRequest;
  try {
    request = parseRequest(id, bytes);
  } catch (error) {
    return { id, kind: "error", message: `unreadable verify request: ${messageOf(error)}` };
  }
  try {
    return await options.handle(request);
  } catch (error) {
    if (options.isFatal?.(error)) {
      throw error;
    }
    return { id, kind: "error", message: `verification failed on the worker: ${messageOf(error)}` };
  }
}

async function listRequests(sandbox: LiveSandbox): Promise<string[]> {
  const listing = await sandbox.execute([
    "sh",
    "-c",
    `ls -1 ${MAILBOX_REQUESTS} 2>/dev/null || true`,
  ]);
  return listing.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".json"))
    .map((line) => line.slice(0, -".json".length))
    .filter((id) => /^[A-Za-z0-9._-]+$/.test(id))
    .sort();
}

async function writeResponse(sandbox: LiveSandbox, response: MailboxResponse): Promise<void> {
  const final = `${MAILBOX_RESPONSES}/${response.id}.json`;
  const temporary = `${final}.tmp`;
  await sandbox.writeFile(temporary, `${JSON.stringify(response)}\n`);
  const moved = await sandbox.execute(["sh", "-c", `mv -f ${temporary} ${final}`]);
  if (moved.exitCode !== 0) {
    throw new Error(`could not deliver verify response ${response.id}: ${moved.stderr}`);
  }
}

function parseRequest(id: string, bytes: Uint8Array): MailboxRequest {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<MailboxRequest>;
  if (
    (parsed.kind !== "task" && parsed.kind !== "fix") ||
    typeof parsed.testPatch !== "string" ||
    parsed.definition === undefined ||
    (parsed.goldPatch !== undefined && typeof parsed.goldPatch !== "string")
  ) {
    throw new Error("request must carry kind, definition, and testPatch");
  }
  return {
    id,
    kind: parsed.kind,
    definition: parsed.definition,
    testPatch: parsed.testPatch,
    ...(parsed.goldPatch !== undefined ? { goldPatch: parsed.goldPatch } : {}),
  };
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
