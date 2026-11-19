import { expect, test } from "bun:test";
import {
  type DaytonaClient,
  DaytonaSandboxExecutor,
} from "../../../../src/sandbox/providers/daytona/executor.js";

const config = {
  kind: "daytona",
  image: "Dockerfile.sandbox@test",
  credentials: { apiKey: "k" },
} as const;

/** Daytona's client and one sandbox, recording what the executor asks of them. */
function fakeDaytona(exitCode: number) {
  const files = new Map<string, string>();
  const created: Record<string, unknown>[] = [];
  const commands: string[] = [];
  const deleted: string[] = [];
  const sandbox = {
    id: "sbx-1",
    fs: {
      uploadFile: async (contents: Buffer, path: string) => void files.set(path, String(contents)),
      downloadFile: async (path: string) => {
        const found = files.get(path);
        if (found === undefined) throw new Error("not found");
        return Buffer.from(found);
      },
    },
    process: {
      executeCommand: async (command: string) => void commands.push(command),
      createSession: async () => undefined,
      executeSessionCommand: async (_session: string, request: { command: string }) => {
        commands.push(request.command);
        files.set("/work/out.txt", "done");
        return { cmdId: "cmd-1" };
      },
      getSessionCommandLogs: async (
        _session: string,
        _cmd: string,
        stdout: (chunk: string) => void,
        stderr: (chunk: string) => void,
      ) => {
        stdout("hello\n");
        stderr("warn\n");
      },
      getSessionCommand: async () => ({ exitCode }),
    },
    delete: async () => void deleted.push("sbx-1"),
  };
  const client = {
    create: async (params: Record<string, unknown>) => {
      created.push(params);
      return sandbox;
    },
    get: async () => sandbox,
  } as unknown as DaytonaClient;
  return { client, files, created, commands, deleted };
}

test("a Daytona run stages files, keeps secrets off the command line, and deletes its sandbox", async () => {
  const daytona = fakeDaytona(3);
  const executor = new DaytonaSandboxExecutor(config, daytona.client);
  const result = await executor.run({
    runId: "run-1",
    stage: "author",
    command: ["bash", "-c", "echo hi"],
    files: [{ path: "/work/in/task.txt", contents: "task" }],
    outputPaths: ["/work/out.txt"],
    secrets: { OPENAI_API_KEY: "sk-secret" },
    timeoutMs: 90 * 60_000,
    memoryMiB: 4096,
  });

  // The command's own exit code, read once its log stream ends.
  expect(result).toMatchObject({ sandboxId: "sbx-1", exitCode: 3, stdout: "hello\n" });
  expect(Buffer.from(result.outputs["/work/out.txt"] ?? []).toString()).toBe("done");
  expect(daytona.created[0]).toMatchObject({
    ephemeral: true,
    autoStopInterval: 0,
    ttlMinutes: 90,
    resources: { cpu: 4, memory: 4 },
  });
  expect(daytona.files.get("/work/in/task.txt")).toBe("task");
  // The secret travels in a sourced file, never in the command Daytona records.
  expect(daytona.commands.join("\n")).not.toContain("sk-secret");
  expect([...daytona.files.values()].join("\n")).toContain("export OPENAI_API_KEY='sk-secret'");
  expect(daytona.deleted).toEqual(["sbx-1"]);
});
