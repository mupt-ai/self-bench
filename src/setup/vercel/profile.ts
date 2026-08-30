import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseSandboxTimeoutCapText } from "../../sandbox/timeout.js";
import {
  ensurePrivateDirectory,
  loadMutableProfileData,
  writePrivateJson,
} from "./profile-files.js";
import {
  configSchema,
  credentialsSchema,
  profileNameSchema,
  type VercelProfile,
  type VercelProfileData,
  vercelProfileSchema,
} from "./profile-schema.js";

export type { VercelProfile, VercelProfileData } from "./profile-schema.js";
export { vercelProfileSchema } from "./profile-schema.js";

const CONFIG_FILE = "config.json";
const CREDENTIALS_FILE = "credentials.json";

export function selfBenchConfigDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.SELFBENCH_CONFIG_DIR?.trim();
  return resolve(override || join(homedir(), ".selfbench"));
}

export function validateVercelProfileName(value: string): string {
  return profileNameSchema.parse(value);
}

export async function loadVercelProfileData(
  directory = selfBenchConfigDirectory(),
): Promise<VercelProfileData> {
  const mutable = await loadMutableProfileData(directory);
  return {
    ...(mutable.activeVercelProfile ? { activeVercelProfile: mutable.activeVercelProfile } : {}),
    profiles: mutable.profiles,
    tokens: mutable.tokens,
  };
}

export async function saveVercelProfile(input: {
  readonly directory?: string;
  readonly profileName: string;
  readonly profile: VercelProfile;
  readonly token: string;
}): Promise<void> {
  const directory = resolve(input.directory ?? selfBenchConfigDirectory());
  const profileName = validateVercelProfileName(input.profileName);
  const token = input.token.trim();
  if (!token) {
    throw new Error("Vercel access token must not be blank");
  }
  const profile = vercelProfileSchema.parse(input.profile);
  await ensurePrivateDirectory(directory);
  const existing = await loadMutableProfileData(directory);
  const nextCredentials = credentialsSchema.parse({
    schemaVersion: 1,
    vercelProfiles: {
      ...Object.fromEntries(
        Object.entries(existing.tokens).map(([name, existingToken]) => [
          name,
          { token: existingToken },
        ]),
      ),
      [profileName]: { token },
    },
  });
  const nextConfig = configSchema.parse({
    schemaVersion: 1,
    activeVercelProfile: profileName,
    vercelProfiles: { ...existing.profiles, [profileName]: profile },
  });

  // Credentials are written first. A crash can leave an unreferenced token, but
  // never an active profile whose credential has not reached disk.
  await writePrivateJson(join(directory, CREDENTIALS_FILE), nextCredentials);
  await writePrivateJson(join(directory, CONFIG_FILE), nextConfig);
}

export async function applyVercelProfile(
  environment: NodeJS.ProcessEnv,
  requestedProfile?: string,
): Promise<NodeJS.ProcessEnv> {
  const result = { ...environment };
  const hasCompleteEnvironment = requiredEnvironmentKeys.every((key) => result[key]?.trim());
  if (hasCompleteEnvironment && requestedProfile === undefined) {
    return result;
  }

  const data = await loadVercelProfileData(selfBenchConfigDirectory(environment));
  const profileName = selectProfileName(data, requestedProfile);
  const profile = data.profiles[profileName];
  const token = data.tokens[profileName];
  if (!profile || !token) {
    throw new Error(
      `Vercel profile "${profileName}" is incomplete; rerun self-bench setup vercel --profile ${profileName}`,
    );
  }
  assertCompatibleOverride("VERCEL_TEAM_ID", result.VERCEL_TEAM_ID, profile.teamId);
  assertCompatibleOverride("VERCEL_PROJECT_ID", result.VERCEL_PROJECT_ID, profile.projectId);

  result.VERCEL_TOKEN = result.VERCEL_TOKEN?.trim() || token;
  result.VERCEL_TEAM_ID = result.VERCEL_TEAM_ID?.trim() || profile.teamId;
  result.VERCEL_PROJECT_ID = result.VERCEL_PROJECT_ID?.trim() || profile.projectId;
  result.SELFBENCH_VERCEL_IMAGE = result.SELFBENCH_VERCEL_IMAGE?.trim() || profile.image;
  result.SELFBENCH_VERCEL_TIMEOUT_CAP = resolveProfileTimeoutCap(
    result.SELFBENCH_VERCEL_TIMEOUT_CAP,
    profile.timeoutCapMs,
  );
  return result;
}

export function profileFilePaths(directory = selfBenchConfigDirectory()): {
  readonly config: string;
  readonly credentials: string;
} {
  return {
    config: join(directory, CONFIG_FILE),
    credentials: join(directory, CREDENTIALS_FILE),
  };
}

const requiredEnvironmentKeys = [
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "SELFBENCH_VERCEL_IMAGE",
] as const;

function selectProfileName(data: VercelProfileData, requestedProfile?: string): string {
  if (requestedProfile !== undefined) {
    return validateVercelProfileName(requestedProfile);
  }
  if (data.activeVercelProfile) {
    return data.activeVercelProfile;
  }
  const names = Object.keys(data.profiles);
  if (names.length === 1 && names[0]) {
    return names[0];
  }
  throw new Error(
    "Vercel is not configured; run self-bench setup vercel or provide VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID, and SELFBENCH_VERCEL_IMAGE",
  );
}

function resolveProfileTimeoutCap(value: string | undefined, verifiedCapMs: number): string {
  const override = value?.trim();
  if (!override) {
    return `${verifiedCapMs}ms`;
  }
  const parsed = parseSandboxTimeoutCapText(override);
  if (parsed === undefined || !Number.isInteger(parsed) || parsed < 100 || parsed > verifiedCapMs) {
    throw new Error(
      `SELFBENCH_VERCEL_TIMEOUT_CAP must be between 100ms and the selected profile's verified ${verifiedCapMs}ms ceiling`,
    );
  }
  return override;
}

function assertCompatibleOverride(key: string, value: string | undefined, expected: string): void {
  const override = value?.trim();
  if (override && override !== expected) {
    throw new Error(
      `${key} does not match the selected Vercel profile; provide the complete Vercel environment instead of mixing project scopes`,
    );
  }
}
