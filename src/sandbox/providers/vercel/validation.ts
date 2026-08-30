import {
  isDigestPinnedOciImage,
  type SelfBenchWorkerConfig,
  type VercelCredentials,
} from "../../../config.js";
import type { SandboxRequest } from "../../contracts.js";
import { validateSandboxRequest } from "../../request-validation.js";

export type VercelExecutionConfig = Extract<
  SelfBenchWorkerConfig["execution"],
  { readonly kind: "vercel" }
>;

export function validateConfig(config: VercelExecutionConfig): VercelExecutionConfig {
  const credentials: VercelCredentials = {
    token: config.credentials.token.trim(),
    teamId: config.credentials.teamId.trim(),
    projectId: config.credentials.projectId.trim(),
  };
  if (!credentials.token || !credentials.teamId || !credentials.projectId) {
    throw new Error("Vercel execution requires a complete nonblank credential triple");
  }
  const image = config.image.trim();
  if (!isDigestPinnedOciImage(image)) {
    throw new Error("Vercel execution requires a digest-pinned image");
  }
  return { kind: "vercel", credentials, image, timeoutCapMs: config.timeoutCapMs };
}

export function validateRequest(request: SandboxRequest): {
  readonly vcpus: number;
  readonly memoryMiB: number;
} {
  validateSandboxRequest(request);
  const vcpus = request.cpu ?? 4;
  if (!Number.isInteger(vcpus) || (vcpus !== 1 && (vcpus < 2 || vcpus > 32 || vcpus % 2 !== 0))) {
    throw new Error("Vercel sandbox CPU must be 1 or an even integer from 2 through 32");
  }
  const memoryMiB = request.memoryMiB ?? vcpus * 2048;
  if (memoryMiB !== vcpus * 2048) {
    throw new Error(
      `Vercel fixes memory at 2048 MiB per vCPU; ${vcpus} vCPU requires ${vcpus * 2048} MiB`,
    );
  }
  return { vcpus, memoryMiB };
}
