import { fileURLToPath } from "node:url";
import type { HarborEnvironment } from "../config/providers.js";

/** Vercel settings a Vercel Harbor environment needs; Harbor resolves team and project from them. */
const VERCEL_HARBOR_SETTINGS = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"] as const;
const VERCEL_CONTROL_CREDENTIALS = [
  "VERCEL_AUTH_TOKEN",
  ...VERCEL_HARBOR_SETTINGS,
  "VERCEL_OIDC_TOKEN",
] as const;

/** E2B settings an E2B Harbor environment legitimately needs; every other `E2B_*` key is dropped. */
const E2B_HARBOR_SETTINGS = ["E2B_API_KEY", "E2B_DOMAIN"] as const;

/**
 * Hosted generation may verify with a different provider account than it
 * generates with, so Harbor credentials travel under these keys and only take
 * their provider names in Harbor's own environment.
 */
export const HARBOR_E2B_API_KEY = "SELFBENCH_HARBOR_E2B_API_KEY";
export const HARBOR_VERCEL_CREDENTIALS = {
  VERCEL_TOKEN: "SELFBENCH_HARBOR_VERCEL_TOKEN",
  VERCEL_TEAM_ID: "SELFBENCH_HARBOR_VERCEL_TEAM_ID",
  VERCEL_PROJECT_ID: "SELFBENCH_HARBOR_VERCEL_PROJECT_ID",
} as const;

export function harborChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  harborEnvironment?: HarborEnvironment,
): NodeJS.ProcessEnv {
  const selected = harborEnvironment ?? "modal";
  const runtimeKeys = [
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
  const providerKeys: Record<HarborEnvironment, readonly string[]> = {
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
    e2b: E2B_HARBOR_SETTINGS,
    vercel: VERCEL_HARBOR_SETTINGS,
    daytona: ["DAYTONA_API_KEY", "DAYTONA_API_URL", "DAYTONA_TARGET"],
  };
  const allowed = new Set([
    ...runtimeKeys,
    ...providerKeys[selected],
    HARBOR_E2B_API_KEY,
    ...Object.values(HARBOR_VERCEL_CREDENTIALS),
  ]);
  const child = Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key)));
  const dedicatedVercel = Object.values(HARBOR_VERCEL_CREDENTIALS).map((key) => environment[key]);
  if (
    selected === "vercel" &&
    dedicatedVercel.some((value) => value !== undefined) &&
    !dedicatedVercel.every((value) => value?.trim())
  ) {
    throw new Error("Harbor Vercel credentials must include token, team, and project");
  }
  const harborVercel = Object.entries(HARBOR_VERCEL_CREDENTIALS).map(
    ([target, source]) => [target, child[source]] as const,
  );
  for (const [, source] of Object.entries(HARBOR_VERCEL_CREDENTIALS)) delete child[source];
  for (const key of VERCEL_CONTROL_CREDENTIALS) {
    if (
      harborEnvironment === "vercel" &&
      (VERCEL_HARBOR_SETTINGS as readonly string[]).includes(key)
    )
      continue;
    delete child[key];
  }
  if (harborEnvironment === "vercel" && harborVercel.every(([, value]) => value))
    for (const [target, value] of harborVercel) child[target] = value;
  const harborE2BKey = child[HARBOR_E2B_API_KEY];
  delete child[HARBOR_E2B_API_KEY];
  for (const key of Object.keys(child)) {
    if (!key.startsWith("E2B_")) continue;
    if (harborEnvironment === "e2b" && (E2B_HARBOR_SETTINGS as readonly string[]).includes(key))
      continue;
    delete child[key];
  }
  if (harborEnvironment === "e2b" && harborE2BKey) child.E2B_API_KEY = harborE2BKey;
  return child;
}

export function harborPythonPath(): string {
  return fileURLToPath(new URL("./runtime/", import.meta.url));
}
