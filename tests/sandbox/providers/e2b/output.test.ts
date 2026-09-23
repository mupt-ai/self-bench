import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../../../src/lib/process.js";
import { E2BSandboxExecutor } from "../../../../src/sandbox/providers/e2b/executor.js";
import { readOutputThroughCommand } from "../../../../src/sandbox/providers/e2b/output.js";
import type { E2BSandboxHandle } from "../../../../src/sandbox/providers/e2b/types.js";
import { E2BSdkFixture, e2bFixtureConfig } from "../../../support/e2b-sdk-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function commandSandbox(run: (command: string) => Promise<string>): E2BSandboxHandle {
  return {
    commands: {
      run: async (command: string) => ({ exitCode: 0, stdout: await run(command), stderr: "" }),
    },
  } as unknown as E2BSandboxHandle;
}

const local = commandSandbox(async (command) => (await runCommand("sh", ["-c", command])).stdout);
const signal = new AbortController().signal;

async function outputFile(bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "e2b-output-"));
  roots.push(root);
  const path = join(root, "output ' $(false).bin");
  await writeFile(path, bytes);
  return path;
}

describe("E2B output recovery", () => {
  test("node -e places the first supplied argument at argv[1]", async () => {
    const result = await runCommand("node", [
      "-e",
      "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
      "/work/material.json",
    ]);
    expect(JSON.parse(result.stdout)).toEqual(["/work/material.json"]);
  });

  test("retrieves exact binary bytes and empty files through the command channel", async () => {
    const bytes = Uint8Array.from({ length: 20_000 }, (_, i) => i % 256);
    expect(await readOutputThroughCommand(local, await outputFile(bytes), signal)).toEqual(
      Buffer.from(bytes),
    );
    expect(
      await readOutputThroughCommand(local, await outputFile(new Uint8Array()), signal),
    ).toEqual(Buffer.alloc(0));
  });

  test("rejects missing and oversized outputs instead of accepting incomplete material", async () => {
    const path = await outputFile(Buffer.alloc(1024 * 1024 + 1));
    await expect(readOutputThroughCommand(local, path, signal)).rejects.toThrow(
      "output exceeds command read limit",
    );
    await expect(readOutputThroughCommand(local, `${path}-missing`, signal)).rejects.toThrow(
      "ENOENT",
    );
  });

  test("rejects truncated or corrupt command responses", async () => {
    const good = Buffer.from("complete material");
    const output = {
      size: good.length,
      sha256: createHash("sha256").update(good).digest("hex"),
      data: good.toString("base64"),
    };
    for (const response of [
      JSON.stringify(output).slice(0, -1),
      JSON.stringify({ ...output, size: good.length + 1 }),
      JSON.stringify({ ...output, sha256: "0".repeat(64) }),
      JSON.stringify({ ...output, data: `${output.data}!` }),
    ]) {
      await expect(
        readOutputThroughCommand(
          commandSandbox(async () => response),
          "/work/material.json",
          signal,
        ),
      ).rejects.toThrow();
    }
  });

  test("cancellation interrupts a stuck command read", async () => {
    const controller = new AbortController();
    const read = readOutputThroughCommand(
      commandSandbox(async () => new Promise(() => {})),
      "/work/material.json",
      controller.signal,
    );
    controller.abort(new Error("cancel output recovery"));
    await expect(read).rejects.toThrow("cancel output recovery");
  });

  test("recovers after exhausted file API reads without rerunning the workload", async () => {
    const fixture = new E2BSdkFixture();
    fixture.exitCode = 0;
    const bytes = Buffer.from('{"material":"verified"}');
    const path = await outputFile(bytes);
    const create = fixture.api.create.bind(fixture.api);
    let reads = 0;
    let recoveries = 0;
    fixture.api.create = async (...args) => {
      const sandbox = await create(...args);
      const run = sandbox.commands.run.bind(sandbox.commands);
      sandbox.files.read = (async () => {
        reads += 1;
        throw new Error("file API unavailable");
      }) as typeof sandbox.files.read;
      sandbox.commands.run = (async (command: string, options: { background?: boolean }) => {
        if (options.background) return run(command, options);
        recoveries += 1;
        // Map the declared /work output to a local fixture only for the recovery command.
        const localCommand = command.replace(
          "'/work/material.json'",
          `'${path.replaceAll("'", `'"'"'`)}'`,
        );
        return await runCommand("sh", ["-c", localCommand]);
      }) as typeof sandbox.commands.run;
      return sandbox;
    };
    const result = await new E2BSandboxExecutor(e2bFixtureConfig, fixture.api, async () => {}).run({
      runId: "output-recovery",
      stage: "material",
      command: ["node", "/work/material.js"],
      outputPaths: ["/work/material.json"],
      timeoutMs: 10_000,
    });
    expect(result.outputs["/work/material.json"]).toEqual(bytes);
    expect(reads).toBe(5);
    expect(recoveries).toBe(1);
    expect(fixture.calls.filter((call) => call === "command.run")).toHaveLength(1);
    expect(fixture.allocationExists).toBe(false);
  });
});
