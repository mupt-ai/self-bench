import { HOSTED_EXECUTION_BACKENDS } from "../../../../src/contracts/config/providers";
import type { CredentialInfo } from "../../../../src/db/credentials";
import { catalog, hostedSandboxes } from "../../../../src/evaluation/catalog";
import { linkedCatalogModels } from "../../../../src/evaluation/link-routes";
import { generationCredentialRuns } from "../../../../src/generation/settings/models";
import { isSandbox } from "../evaluation/credential-presentation";

/** Whether a workflow has a model and a sandbox to run on. */
export interface Coverage {
  model: boolean;
  sandbox: boolean;
}

type Credential = Pick<CredentialInfo, "kind" | "auth" | "linkModels">;

/**
 * What an organization's credentials let it run, by the same rules the generation and
 * evaluation forms apply. Generation runs Pi, so a Dari connection generates with any model it
 * serves for any app (a Claude or Muse plan's models run only their own agent, and do not count).
 * Both run on any hosted sandbox. Managed access, where offered, covers either half.
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
          [...catalog, ...linkedCatalogModels(catalog, [credential])].some((model) =>
            generationCredentialRuns(model, credential),
          ),
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
      // A provider sign-in saved before Connect with Dari runs nothing.
      model:
        !!managed.models ||
        has(
          (credential) =>
            !isSandbox(credential.kind) &&
            (credential.auth === "api-key" || credential.auth === "dari-link"),
        ),
      sandbox:
        !!managed.sandbox ||
        has((credential) => (hostedSandboxes as readonly string[]).includes(credential.kind)),
    },
  };
}

export const covered = (coverage: Coverage) => coverage.model && coverage.sandbox;
