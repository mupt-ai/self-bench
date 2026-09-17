import { expect, test } from "bun:test";
import { RollingOutput, type runCommand } from "../../../../src/process.js";
import {
  cleanupDockerResources,
  DockerCleanupError,
} from "../../../../src/sandbox/providers/docker/cleanup.js";

const ok = { exitCode: 0, stdout: "", stderr: "" };
const denied = { ...ok, exitCode: 1, stderr: "No such container (daemon unavailable)" };
const name = "selfbench-test";

test("successful removals need no absence probes", async () => {
  const calls: string[][] = [];
  await cleanupDockerResources(name, async (command, args, options) => {
    expect(command).toBe("docker");
    expect(options?.timeoutMs).toBe(10_000);
    expect(options?.signal?.aborted).toBe(false);
    calls.push([...args]);
    return ok;
  });
  expect(calls).toEqual([
    ["rm", "--force", name],
    ["volume", "rm", "--force", name],
  ]);
});

test("failed removal is absent only after complete successful exact-name listing", async () => {
  const calls: string[][] = [];
  await cleanupDockerResources(name, async (_, args) => {
    calls.push([...args]);
    return args.includes("ls") ? { ...ok, stdout: `"${name}-other"\n"other-${name}"\n` } : denied;
  });
  expect(calls).toContainEqual(["container", "ls", "--all", "--format", "{{json .Names}}"]);
  expect(calls).toContainEqual(["volume", "ls", "--format", "{{json .Name}}"]);
});

for (const listing of [
  denied,
  { ...ok, stdout: `"${name}"\n` },
  { ...ok, stdout: `[selfbench: earlier output truncated]\n"other"\n` },
  { ...ok, stdout: "null\n" },
  { ...ok, stdout: '""\n' },
]) {
  test(`unconfirmed listing rejects and still attempts both removals: ${JSON.stringify(listing)}`, async () => {
    const removals: string[] = [];
    const run: typeof runCommand = async (_, args) => {
      if (args.includes("ls")) return listing;
      removals.push(args[0] ?? "");
      return denied;
    };
    await expect(cleanupDockerResources(name, run)).rejects.toBeInstanceOf(DockerCleanupError);
    expect(removals).toEqual(["rm", "volume"]);
  });
}

test("runner rejection can be recovered by reliable empty listing", async () => {
  await cleanupDockerResources(name, async (_, args) => {
    if (args.includes("ls")) return ok;
    throw new Error("runner failed");
  });
});

test("hung cleanup is locally bounded, aborts each CLI, and attempts both resources", async () => {
  const calls: string[][] = [];
  const signals: AbortSignal[] = [];
  const run: typeof runCommand = async (_, args, options) => {
    calls.push([...args]);
    expect(options?.timeoutMs).toBe(5);
    if (options?.signal) signals.push(options.signal);
    return await new Promise(() => {});
  };
  await expect(cleanupDockerResources(name, run, 5)).rejects.toMatchObject({
    ownershipFailure: true,
  });
  expect(calls.map((args) => args.slice(0, 2))).toEqual([
    ["rm", "--force"],
    ["container", "ls"],
    ["volume", "rm"],
    ["volume", "ls"],
  ]);
  expect(signals).toHaveLength(4);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

test("one failed resource is enough to reject even when the other removal succeeds", async () => {
  await expect(
    cleanupDockerResources(name, async (_, args) => (args[0] === "volume" ? ok : denied)),
  ).rejects.toMatchObject({ ownershipFailure: true, errors: expect.any(Array) });
});

for (const alias of [`/${name}`, `other,${name}`, `other, /${name}`]) {
  test(`container alias ${alias} prevents false absence`, async () => {
    await expect(
      cleanupDockerResources(name, async (_, args) => {
        if (args[0] === "volume") return ok;
        return args.includes("ls") ? { ...ok, stdout: `${JSON.stringify(alias)}\n` } : denied;
      }),
    ).rejects.toBeInstanceOf(DockerCleanupError);
  });
}

test("real RollingOutput truncation cannot prove absence after dropping the target", async () => {
  const output = new RollingOutput();
  output.push(Buffer.from(`${JSON.stringify(name)}\n`));
  output.push(Buffer.from('"other"\n'.repeat(1_200_000)));
  expect(output.text()).not.toContain(name);
  await expect(
    cleanupDockerResources(name, async (_, args) =>
      args.includes("ls") ? { ...ok, stdout: output.text() } : denied,
    ),
  ).rejects.toBeInstanceOf(DockerCleanupError);
});
