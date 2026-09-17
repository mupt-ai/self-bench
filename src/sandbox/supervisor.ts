import type { LiveSandbox } from "./contracts.js";

export const MAILBOX_DIRECTORY = "/work/mailbox";
export const MAILBOX_REQUESTS = `${MAILBOX_DIRECTORY}/requests`;
export const MAILBOX_RESPONSES = `${MAILBOX_DIRECTORY}/responses`;
export const MAILBOX_DONE = `${MAILBOX_DIRECTORY}/done`;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

export interface MailboxRequest {
  readonly id: string;
  readonly kind: "task";
  readonly definition: unknown;
  readonly testPatch: string;
  readonly goldPatch: string;
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
    if (exited.aborted) return { handled, stoppedBy: "exited" };
    let handling = false;
    let done = false;
    try {
      const requests = await listRequests(sandbox);
      if (exited.aborted) return { handled, stoppedBy: "exited" };
      for (const id of requests) {
        if (seen.has(id) || exited.aborted) {
          continue;
        }
        seen.add(id);
        const bytes = await sandbox.readFile(`${MAILBOX_REQUESTS}/${id}.json`);
        if (exited.aborted) return { handled, stoppedBy: "exited" };
        if (!bytes) {
          continue;
        }
        handling = true;
        const response = await respond(id, bytes, options);
        handling = false;
        if (exited.aborted) return { handled, stoppedBy: "exited" };
        handled += 1;
        await writeResponse(sandbox, response, exited);
      }
      if (exited.aborted) return { handled, stoppedBy: "exited" };
      done = (await sandbox.readFile(MAILBOX_DONE)) !== undefined;
      if (exited.aborted) return { handled, stoppedBy: "exited" };
      options.onPoll?.();
    } catch (error) {
      // Only expected idle cancellation is normal shutdown. An active handler
      // owns work whose failure must still reach the provider.
      if (!handling && exited.aborted && error === exited.reason) {
        return { handled, stoppedBy: "exited" };
      }
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

async function writeResponse(
  sandbox: LiveSandbox,
  response: MailboxResponse,
  exited: AbortSignal,
): Promise<void> {
  exited.throwIfAborted();
  const final = `${MAILBOX_RESPONSES}/${response.id}.json`;
  const temporary = `${final}.tmp`;
  await sandbox.writeFile(temporary, `${JSON.stringify(response)}\n`);
  exited.throwIfAborted();
  const moved = await sandbox.execute(["sh", "-c", `mv -f ${temporary} ${final}`]);
  if (moved.exitCode !== 0) {
    throw new Error(`could not deliver verify response ${response.id}: ${moved.stderr}`);
  }
}

function parseRequest(id: string, bytes: Uint8Array): MailboxRequest {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Partial<MailboxRequest>;
  if (
    parsed.kind !== "task" ||
    typeof parsed.testPatch !== "string" ||
    parsed.definition === undefined ||
    typeof parsed.goldPatch !== "string"
  ) {
    throw new Error("request must carry kind=task, definition, testPatch, and goldPatch");
  }
  return {
    id,
    kind: parsed.kind,
    definition: parsed.definition,
    testPatch: parsed.testPatch,
    goldPatch: parsed.goldPatch,
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
