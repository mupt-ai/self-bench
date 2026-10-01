import { HOSTED_EXECUTION_BACKENDS } from "../../../../src/contracts/config/providers";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { hostedSandboxes } from "../../../../src/evaluation/catalog";
import { generationModels } from "../../../../src/generation/settings/models";
import { isSandbox } from "../evaluation/credential-presentation";
import { modelCredentialMatches } from "../generation-defaults";

/** Whether a workflow has a model and a sandbox to run on. */
export interface Coverage {
  model: boolean;
  sandbox: boolean;
}

type Credential = Pick<CredentialInfo, "kind" | "auth">;

/**
 * What an organization's credentials let it run, by the same rules the generation and
 * evaluation forms apply. Generation authors and verifies in Pi, so a Claude sign-in (Claude
 * Code only) cannot generate, and its sandboxes are Modal, Vercel, or E2B; evaluation runs any
 * model credential on E2B, Modal, or Daytona. Managed access, where offered, covers either half.
 */
export function setupCoverage(
  credentials: readonly Credential[],
  managed: { models?: boolean; sandbox?: boolean } = {},
): { generate: Coverage; evaluate: Coverage } {
  const has = (test: (credential: Credential) => boolean) => credentials.some(test);
  return {
    generate: {
      model:
        !!managed.models ||
        has((credential) =>
          generationModels.some((model) => modelCredentialMatches(credential, model, model)),
        ),
      sandbox:
        !!managed.sandbox ||
        has(
          (credential) =>
            credential.auth === "api-key" &&
            (HOSTED_EXECUTION_BACKENDS as readonly string[]).includes(credential.kind),
        ),
    },
    evaluate: {
      model: !!managed.models || has((credential) => !isSandbox(credential.kind)),
      sandbox:
        !!managed.sandbox ||
        has((credential) => (hostedSandboxes as readonly string[]).includes(credential.kind)),
    },
  };
}

export const covered = (coverage: Coverage) => coverage.model && coverage.sandbox;

/** The setup page, returning to `from` when that is a page that sends people there. */
export function setupPath(from?: string) {
  return from ? `/get-started?return=${encodeURIComponent(from)}` : "/get-started";
}

/** Where the setup page's finish links back to, and what it calls that page. */
export function setupReturn(target: string | null): { to: string; label: string } | undefined {
  const match = target?.match(/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(run|batches)$/);
  if (!match || !target) return undefined;
  return { to: target, label: match[1] === "run" ? "Back to Run" : "Back to Batch Generation" };
}
