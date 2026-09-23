import type { HarborEnvironment } from "../contracts/config/providers.js";

/** The environment each sandbox provider's SDK or CLI reads. */
const PROVIDER_KEYS: Record<HarborEnvironment, readonly string[]> = {
  docker: [
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ],
  modal: [
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
    "MODAL_ENVIRONMENT",
    "MODAL_PROFILE",
    "MODAL_CONFIG_PATH",
  ],
  e2b: ["E2B_API_KEY", "E2B_DOMAIN"],
  vercel: ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
  daytona: ["DAYTONA_API_KEY", "DAYTONA_API_URL", "DAYTONA_TARGET"],
};

const RUNTIME_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "PYTHONUNBUFFERED",
];

/**
 * Hosted runs may verify with a different provider account than they generate with, so the
 * verification (Harbor) credentials travel under these keys and replace the provider's own.
 */
const VERIFICATION_CREDENTIALS = {
  E2B_API_KEY: "SELFBENCH_HARBOR_E2B_API_KEY",
  VERCEL_TOKEN: "SELFBENCH_HARBOR_VERCEL_TOKEN",
  VERCEL_TEAM_ID: "SELFBENCH_HARBOR_VERCEL_TEAM_ID",
  VERCEL_PROJECT_ID: "SELFBENCH_HARBOR_VERCEL_PROJECT_ID",
} as const;

/**
 * The environment for a process that drives one sandbox provider (Harbor): the basic runtime
 * variables plus that provider's credentials, preferring the dedicated verification ones.
 * Nothing else from the worker, including other providers' credentials, is passed on.
 */
export function providerEnvironment(
  environment: NodeJS.ProcessEnv,
  provider: HarborEnvironment = "modal",
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const key of [...RUNTIME_KEYS, ...PROVIDER_KEYS[provider]]) {
    if (environment[key] !== undefined) child[key] = environment[key];
  }
  const overrides = Object.entries(VERIFICATION_CREDENTIALS).filter(([target]) =>
    PROVIDER_KEYS[provider].includes(target),
  );
  const values = overrides.map(([, source]) => environment[source]?.trim());
  if (values.some(Boolean) && !values.every(Boolean)) {
    throw new Error(`verification ${provider} credentials are incomplete`);
  }
  for (const [target, source] of overrides) {
    if (environment[source]) child[target] = environment[source];
  }
  return child;
}

/** A worker's own provider credentials; none may reach a sandbox driven for a user's run. */
export const WORKER_PROVIDER_CREDENTIALS = [
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "E2B_API_KEY",
  "E2B_DOMAIN",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_OIDC_TOKEN",
  "DAYTONA_API_KEY",
  ...Object.values(VERIFICATION_CREDENTIALS),
] as const;

interface ProviderSecret {
  readonly value: string;
  readonly tokenId?: string;
  readonly teamId?: string;
  readonly projectId?: string;
  /** Only the platform's managed E2B account carries a custom domain. */
  readonly domain?: string | undefined;
}

/**
 * A stored provider credential as the variables that provider's SDK or CLI reads. A Harbor
 * (verification) credential travels under the dedicated keys `providerEnvironment` prefers,
 * so it can differ from the generation sandbox account.
 */
export function providerCredentialEnvironment(
  provider: HarborEnvironment,
  secret: ProviderSecret,
  role: "sandbox" | "harbor" = "sandbox",
): Record<string, string> {
  const verification = role === "harbor";
  switch (provider) {
    case "docker":
      return {};
    case "modal":
      if (!secret.tokenId) throw new Error("Modal credential is unavailable.");
      return { MODAL_TOKEN_ID: secret.tokenId, MODAL_TOKEN_SECRET: secret.value };
    case "e2b":
      return {
        [verification ? VERIFICATION_CREDENTIALS.E2B_API_KEY : "E2B_API_KEY"]: secret.value,
        ...(secret.domain ? { E2B_DOMAIN: secret.domain } : {}),
      };
    case "daytona":
      return { DAYTONA_API_KEY: secret.value };
    case "vercel":
      if (!secret.teamId || !secret.projectId) throw new Error("Vercel credential is unavailable.");
      return verification
        ? {
            [VERIFICATION_CREDENTIALS.VERCEL_TOKEN]: secret.value,
            [VERIFICATION_CREDENTIALS.VERCEL_TEAM_ID]: secret.teamId,
            [VERIFICATION_CREDENTIALS.VERCEL_PROJECT_ID]: secret.projectId,
          }
        : {
            VERCEL_TOKEN: secret.value,
            VERCEL_TEAM_ID: secret.teamId,
            VERCEL_PROJECT_ID: secret.projectId,
          };
  }
}
