import type { HarborEnvironment } from "../contracts/config/providers.js";
import { modalHarborSandboxes } from "./providers/modal/harbor-sandboxes.js";

/**
 * The sandboxes one `harbor run` starts. Harbor stops them itself when it gets to finish, but a
 * run killed during its own cleanup left them running until the provider's limits ended them.
 */
export interface HarborSandboxes {
  /** Harbor `--ek` settings that mark every sandbox the run starts as the run's. */
  readonly environmentKwargs: Readonly<Record<string, string>>;
  /** Terminates any of the run's sandboxes still running. Bounded, and never throws. */
  sweep(): Promise<void>;
}

/** Only Modal is swept; every other provider's sandboxes end with Harbor or by their own limits. */
export function harborSandboxes(
  provider: HarborEnvironment,
  env: NodeJS.ProcessEnv,
): HarborSandboxes {
  return provider === "modal"
    ? modalHarborSandboxes(env)
    : { environmentKwargs: {}, sweep: async () => undefined };
}
