import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModalClient } from "modal";
import type { Vault } from "../db/vault.js";
import { credentialExecution } from "./execution.js";
import type { EvaluationInput } from "./types.js";

/** Modal tags on a trial's sandboxes: Harbor's agent environment and its separate verifier. */
export function trialSandboxLabels(evaluationId: string, index: number): Record<string, string> {
  return { "selfbench.evaluation": evaluationId, "selfbench.trial": String(index) };
}

/**
 * Terminates the Modal sandboxes one ended trial left running, or every trial's when `index` is
 * omitted. A worker killed mid-trial never runs Harbor's teardown, so without this its sandboxes
 * run on until their lifetime cap. Returns how many it terminated.
 */
export async function terminateTrialSandboxes(
  input: EvaluationInput,
  index: number | undefined,
  env: NodeJS.ProcessEnv,
  vault: Pick<Vault, "credentials" | "comparisons">,
): Promise<number> {
  if (input.sandbox !== "modal") return 0;
  const home = await mkdtemp(join(tmpdir(), "selfbench-sandbox-cleanup-"));
  try {
    const { child } = await credentialExecution(input, home, env, vault);
    const { MODAL_TOKEN_ID: tokenId, MODAL_TOKEN_SECRET: tokenSecret, MODAL_ENVIRONMENT } = child;
    if (!tokenId || !tokenSecret) throw new Error("Modal credential is unavailable");
    const client = new ModalClient({
      tokenId,
      tokenSecret,
      ...(MODAL_ENVIRONMENT ? { environment: MODAL_ENVIRONMENT } : {}),
    });
    try {
      const tags =
        index === undefined
          ? { "selfbench.evaluation": input.id }
          : trialSandboxLabels(input.id, index);
      let terminated = 0;
      for await (const sandbox of client.sandboxes.list({ tags })) {
        await sandbox.terminate();
        terminated += 1;
      }
      return terminated;
    } finally {
      client.close();
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
