import { describe, expect, test } from "bun:test";
import type { LiveSandbox } from "../../src/sandbox/contracts.js";
import {
  MAILBOX_DONE,
  MAILBOX_REQUESTS,
  MAILBOX_RESPONSES,
  type MailboxRequest,
  superviseMailbox,
} from "../../src/sandbox/supervisor.js";

class FakeSandbox implements LiveSandbox {
  readonly sandboxId = "sb-fake";
  readonly files = new Map<string, string>();
  readonly commands: string[] = [];

  async execute(command: readonly string[]) {
    const script = command[2] ?? "";
    this.commands.push(script);
    if (script.startsWith(`ls -1 ${MAILBOX_REQUESTS}`)) {
      const names = [...this.files.keys()]
        .filter((path) => path.startsWith(`${MAILBOX_REQUESTS}/`))
        .map((path) => path.slice(MAILBOX_REQUESTS.length + 1));
      return { exitCode: 0, stdout: `${names.join("\n")}\n`, stderr: "" };
    }
    const move = /^mv -f (\S+) (\S+)$/.exec(script);
    if (move?.[1] && move[2]) {
      const contents = this.files.get(move[1]);
      if (contents === undefined) {
        return { exitCode: 1, stdout: "", stderr: "missing" };
      }
      this.files.delete(move[1]);
      this.files.set(move[2], contents);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 127, stdout: "", stderr: `unknown ${script}` };
  }

  async readFile(path: string) {
    const contents = this.files.get(path);
    return contents === undefined ? undefined : Buffer.from(contents);
  }

  async writeFile(path: string, contents: Uint8Array | string) {
    this.files.set(
      path,
      typeof contents === "string" ? contents : Buffer.from(contents).toString(),
    );
  }

  request(id: string, body: Record<string, unknown>) {
    this.files.set(`${MAILBOX_REQUESTS}/${id}.json`, JSON.stringify(body));
  }

  response(id: string): Record<string, unknown> | undefined {
    const contents = this.files.get(`${MAILBOX_RESPONSES}/${id}.json`);
    return contents === undefined ? undefined : (JSON.parse(contents) as Record<string, unknown>);
  }
}

const immediate = async (_ms: number, signal: AbortSignal) => {
  await new Promise<void>((resolve) => setTimeout(resolve, signal.aborted ? 0 : 1));
};

describe("mailbox supervisor", () => {
  test("handles requests as they appear, writes responses atomically, and stops on the done marker", async () => {
    const sandbox = new FakeSandbox();
    const handled: MailboxRequest[] = [];
    const exited = new AbortController();
    const run = superviseMailbox(sandbox, exited.signal, {
      pollIntervalMs: 1,
      sleep: immediate,
      handle: async (request) => {
        handled.push(request);
        if (request.id === "r2") {
          sandbox.files.set(MAILBOX_DONE, "");
        }
        return {
          id: request.id,
          kind: "report",
          green: request.id === "r2",
          summary: `${request.kind} ${request.id}`,
          rendered: "# report",
        };
      },
    });
    sandbox.request("r1", {
      kind: "task",
      definition: { taskId: "t" },
      testPatch: "diff --git a b",
      goldPatch: "diff --git c d",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    sandbox.request("r2", {
      kind: "fix",
      definition: { taskId: "t" },
      testPatch: "diff --git a b",
    });

    const summary = await run;

    expect(summary).toEqual({ handled: 2, stoppedBy: "done" });
    expect(handled.map((request) => [request.id, request.kind])).toEqual([
      ["r1", "task"],
      ["r2", "fix"],
    ]);
    expect(sandbox.response("r1")).toEqual(
      expect.objectContaining({ kind: "report", green: false }),
    );
    expect(sandbox.response("r2")).toEqual(
      expect.objectContaining({ kind: "report", green: true }),
    );
    expect(sandbox.commands.some((command) => command.includes(".json.tmp"))).toBe(true);
    expect([...sandbox.files.keys()].some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  test("stops when the command exits and reports unreadable or failing requests as errors", async () => {
    const sandbox = new FakeSandbox();
    const exited = new AbortController();
    sandbox.files.set(`${MAILBOX_REQUESTS}/bad.json`, "{not json");
    sandbox.request("boom", { kind: "task", definition: {}, testPatch: "x", goldPatch: "y" });
    const run = superviseMailbox(sandbox, exited.signal, {
      pollIntervalMs: 1,
      sleep: immediate,
      handle: async () => {
        throw new Error("harbor exploded");
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    exited.abort();

    const summary = await run;

    expect(summary.stoppedBy).toBe("exited");
    expect(sandbox.response("bad")).toEqual({
      id: "bad",
      kind: "error",
      message: expect.stringContaining("unreadable verify request"),
    });
    expect(sandbox.response("boom")).toEqual({
      id: "boom",
      kind: "error",
      message: "verification failed on the worker: harbor exploded",
    });
  });

  test("rethrows fatal handler errors", async () => {
    const sandbox = new FakeSandbox();
    sandbox.request("r1", { kind: "task", definition: {}, testPatch: "x", goldPatch: "y" });
    const cancelled = new Error("cancelled");
    await expect(
      superviseMailbox(sandbox, new AbortController().signal, {
        pollIntervalMs: 1,
        sleep: immediate,
        isFatal: (error) => error === cancelled,
        handle: async () => {
          throw cancelled;
        },
      }),
    ).rejects.toBe(cancelled);
  });

  test("tolerates transient sandbox errors while polling", async () => {
    const sandbox = new FakeSandbox();
    let failures = 0;
    const flaky: LiveSandbox = {
      sandboxId: "flaky",
      execute: async (command) => {
        if (failures < 2) {
          failures += 1;
          throw new Error("container not running yet");
        }
        return await sandbox.execute(command);
      },
      readFile: (path) => sandbox.readFile(path),
      writeFile: (path, contents) => sandbox.writeFile(path, contents),
    };
    sandbox.files.set(MAILBOX_DONE, "");
    const errors: unknown[] = [];

    const summary = await superviseMailbox(flaky, new AbortController().signal, {
      pollIntervalMs: 1,
      sleep: immediate,
      handle: async () => {
        throw new Error("unused");
      },
      onPoll: (error) => {
        if (error) {
          errors.push(error);
        }
      },
    });

    expect(summary).toEqual({ handled: 0, stoppedBy: "done" });
    expect(errors).toHaveLength(2);
  });
});
