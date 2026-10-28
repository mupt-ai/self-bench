import { signTrialKey, type TrialKey } from "./trial-key.js";

/** Where the API serves the gateway: `/gateway/v1/messages`, `/gateway/v1/responses`, … */
export const GATEWAY_PATH = "/gateway";

/** How long a trial key stays valid: past the longest trial, short enough to bound a leak. */
const TRIAL_KEY_TTL_MS = 12 * 60 * 60 * 1000;

/** What a trial's agent and judge in a sandbox need to call their models through the gateway. */
export interface GatewayConnection {
  /** OpenAI-compatible base (Chat Completions and Responses): `<api>/gateway/v1`. */
  readonly openAiBase: string;
  /** Anthropic Messages base, for Claude Code: `<api>/gateway`. */
  readonly anthropicBase: string;
  /** The trial key, sent as the API key under whichever variable the harness reads. */
  readonly key: string;
  /** The one host the sandbox must reach for model calls. */
  readonly host: string;
}

/**
 * A connection to the gateway at `apiUrl` (the API's address as sandboxes reach it, the same one
 * sandbox callbacks use), under a key granting what `key` names.
 */
export function gatewayConnection(
  apiUrl: string,
  secret: string,
  key: Omit<TrialKey, "expiresAt">,
  now = Date.now(),
): GatewayConnection {
  const base = `${apiUrl.replace(/\/+$/, "")}${GATEWAY_PATH}`;
  return {
    openAiBase: `${base}/v1`,
    anthropicBase: base,
    key: signTrialKey({ ...key, expiresAt: now + TRIAL_KEY_TTL_MS }, secret),
    host: new URL(base).hostname,
  };
}
