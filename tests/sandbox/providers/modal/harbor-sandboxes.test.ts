import { expect, test } from "bun:test";
import { type ModalClient, NotFoundError } from "modal";
import { terminateTaggedSandboxes } from "../../../../src/sandbox/providers/modal/harbor-sandboxes.js";

type Client = Pick<ModalClient, "apps" | "sandboxes">;

/** A Modal workspace whose `__harbor__` app holds `v1` and `v2` sandboxes matching any tag filter. */
function workspace(v1: string[], v2: string[]) {
  const terminated: string[] = [];
  const filters: unknown[] = [];
  const listing = (ids: string[]) =>
    async function* (filter: unknown) {
      filters.push(filter);
      for (const sandboxId of ids) {
        yield {
          sandboxId,
          terminate: async () => {
            terminated.push(sandboxId);
          },
        };
      }
    };
  const client = {
    apps: {
      fromName: async (name: string) => {
        if (name !== "__harbor__") throw new NotFoundError(`no app ${name}`);
        return { appId: "ap-harbor" };
      },
    },
    sandboxes: { list: listing(v1), experimentalList: listing(v2) },
  } as unknown as Client;
  return { client, terminated, filters };
}

test("terminates the run's tagged sandboxes in Harbor's app, V2 ones included", async () => {
  const { client, terminated, filters } = workspace(["sb-v1"], ["sb-01V2agent", "sb-01V2verifier"]);

  await terminateTaggedSandboxes(client, { "selfbench.harbor_run": "run-1" });

  for (const filter of filters)
    expect(filter).toEqual({ appId: "ap-harbor", tags: { "selfbench.harbor_run": "run-1" } });
  expect(terminated.sort()).toEqual(["sb-01V2agent", "sb-01V2verifier", "sb-v1"]);
});

test("a sweep neither throws when Modal fails nor waits past its timeout when Modal hangs", async () => {
  const failing = {
    apps: {
      fromName: async () => {
        throw new Error("UNAVAILABLE");
      },
    },
  } as unknown as Client;
  await expect(terminateTaggedSandboxes(failing, { tag: "a" })).resolves.toBeUndefined();

  const hanging = {
    apps: { fromName: () => new Promise(() => undefined) },
  } as unknown as Client;
  const startedAt = Date.now();
  await expect(terminateTaggedSandboxes(hanging, { tag: "a" }, 100)).resolves.toBeUndefined();
  expect(Date.now() - startedAt).toBeLessThan(2_000);
});
