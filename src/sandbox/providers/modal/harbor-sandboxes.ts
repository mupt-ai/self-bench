import { ModalClient, NotFoundError, type Sandbox } from "modal";
import { errorMessage } from "../../../lib/util.js";
import type { HarborSandboxes } from "../../harbor-sandboxes.js";

/** The Modal tag on every sandbox one `harbor run` starts, alongside Harbor's own `harbor.*` tags. */
const RUN_TAG = "selfbench.harbor_run";
/** The Modal app Harbor starts its sandboxes in (ModalEnvironment's default `app_name`). */
const HARBOR_APP = "__harbor__";
/** Long enough to list and terminate a trial's few sandboxes; a sweep never holds up its trial longer. */
const SWEEP_TIMEOUT_MS = 30_000;

/**
 * Tags the run's sandboxes through Harbor's `labels` environment kwarg, and sweeps them with the
 * same Modal account and environment Harbor used (`env` is Harbor's own process environment).
 */
export function modalHarborSandboxes(env: NodeJS.ProcessEnv): HarborSandboxes {
  const tags = { [RUN_TAG]: crypto.randomUUID() };
  return {
    environmentKwargs: { labels: JSON.stringify(tags) },
    async sweep() {
      let client: ModalClient | undefined;
      try {
        client = new ModalClient({
          ...(env.MODAL_TOKEN_ID ? { tokenId: env.MODAL_TOKEN_ID } : {}),
          ...(env.MODAL_TOKEN_SECRET ? { tokenSecret: env.MODAL_TOKEN_SECRET } : {}),
          ...(env.MODAL_ENVIRONMENT ? { environment: env.MODAL_ENVIRONMENT } : {}),
        });
        await terminateTaggedSandboxes(client, tags);
      } catch (error) {
        console.warn(`Could not sweep Harbor's Modal sandboxes: ${errorMessage(error)}`);
      } finally {
        client?.close();
      }
    },
  };
}

/**
 * Terminates every running sandbox in Harbor's app carrying `tags`. Best effort: it gives up after
 * `timeoutMs` and reports failures in the log rather than throwing, so a trial never fails or
 * hangs on it.
 */
export async function terminateTaggedSandboxes(
  client: Pick<ModalClient, "apps" | "sandboxes">,
  tags: Readonly<Record<string, string>>,
  timeoutMs = SWEEP_TIMEOUT_MS,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const sweep = (async () => {
    const app = await client.apps
      .fromName(HARBOR_APP)
      .catch((error: unknown) =>
        error instanceof NotFoundError ? undefined : Promise.reject(error),
      );
    if (!app) return [];
    // Harbor's Modal (1.6 and later) starts V2 sandboxes, which `list` leaves out.
    const filter = { appId: app.appId, tags: { ...tags } };
    const listed = await Promise.allSettled([
      collect(client.sandboxes.list(filter)),
      collect(client.sandboxes.experimentalList(filter)),
    ]);
    const left = listed.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    await Promise.allSettled(left.map((sandbox) => sandbox.terminate()));
    return left.map((sandbox) => sandbox.sandboxId);
  })();
  try {
    const outcome = await Promise.race([sweep, timeout]);
    if (outcome === "timeout") {
      sweep.catch(() => undefined);
      console.warn(
        `Gave up sweeping Modal sandboxes tagged ${JSON.stringify(tags)} after ${timeoutMs}ms`,
      );
    } else if (outcome.length > 0) {
      console.warn(`Terminated Modal sandboxes Harbor left running: ${outcome.join(", ")}`);
    }
  } catch (error) {
    console.warn(
      `Could not sweep Modal sandboxes tagged ${JSON.stringify(tags)}: ${errorMessage(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function collect(sandboxes: AsyncGenerator<Sandbox>): Promise<Sandbox[]> {
  const collected: Sandbox[] = [];
  for await (const sandbox of sandboxes) collected.push(sandbox);
  return collected;
}
