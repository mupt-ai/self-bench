import { type PinnedThinking, signTrialKey } from "./trial-key.js";

/** Where the API serves the gateway: `/gateway/v1/messages`, `/gateway/v1/responses`, … */
export const GATEWAY_PATH = "/gateway";

/** How long a trial key stays valid: past the longest trial, short enough to bound a leak. */
const TRIAL_KEY_TTL_MS = 12 * 60 * 60 * 1000;

/** What an agent in a sandbox needs to call one model through SelfBench's gateway. */
export interface GatewayConnection {
  /** OpenAI-compatible base (Chat Completions and Responses): `<api>/gateway/v1`. */
  readonly openAiBase: string;
  /** Anthropic Messages base, for Claude Code: `<api>/gateway`. */
  readonly anthropicBase: string;
  /** The trial key, sent as the API key under whichever variable the harness reads. */
  readonly key: string;
  /** The model name the harness must send: the strict router serves only this. */
  readonly requestModel: string;
  /** The one host the sandbox must reach for model calls. */
  readonly host: string;
}

/**
 * A connection to the gateway at `apiUrl` (the API's address as sandboxes reach it, the same one
 * sandbox callbacks use) for `model`, the gateway's `provider/model` id, on one org credential.
 */
export function gatewayConnection(args: {
  apiUrl: string;
  secret: string;
  orgId: number;
  credentialId: string;
  model: string;
  /** The thinking level every call is served at (TrialKey.thinking). */
  thinking?: PinnedThinking;
  tags: Readonly<Record<string, string>>;
  now?: number;
}): GatewayConnection {
  const base = `${args.apiUrl.replace(/\/+$/, "")}${GATEWAY_PATH}`;
  return {
    openAiBase: `${base}/v1`,
    anthropicBase: base,
    key: signTrialKey(
      {
        orgId: args.orgId,
        credentialId: args.credentialId,
        model: args.model,
        ...(args.thinking ? { thinking: args.thinking } : {}),
        tags: args.tags,
        expiresAt: (args.now ?? Date.now()) + TRIAL_KEY_TTL_MS,
      },
      args.secret,
    ),
    requestModel: `dari/model/${args.model}`,
    host: new URL(base).hostname,
  };
}
