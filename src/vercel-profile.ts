import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { parseSandboxTimeoutCapText, STANDARD_VERCEL_TIMEOUT_CAP_MS } from "./sandbox-timeout.js";

const CONFIG_FILE = "config.json";
const CREDENTIALS_FILE = "credentials.json";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

const profileNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, {
    error: "Vercel profile name must use 1-64 letters, digits, dots, underscores, or hyphens",
  });

const digestPinnedImageSchema = z
  .string()
  .regex(/^[^@\s]+@sha256:[0-9a-f]{64}$/i, "expected a digest-pinned VCR image");

export const vercelProfileSchema = z
  .object({
    teamId: z.string().trim().min(1),
    teamSlug: z.string().trim().min(1),
    teamName: z.string().trim().min(1),
    projectId: z.string().trim().min(1),
    projectName: z.string().trim().min(1),
    vcrRepository: z.string().trim().min(1),
    image: digestPinnedImageSchema,
    runtimeFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    timeoutCapMs: z.number().int().min(100).max(STANDARD_VERCEL_TIMEOUT_CAP_MS),
    capabilityCheckedAt: z.iso.datetime(),
  })
  .strict();

export type VercelProfile = z.infer<typeof vercelProfileSchema>;

const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    activeVercelProfile: profileNameSchema.optional(),
    vercelProfiles: z.record(profileNameSchema, vercelProfileSchema),
  })
  .strict();

const credentialsSchema = z
  .object({
    schemaVersion: z.literal(1),
    vercelProfiles: z.record(
      profileNameSchema,
      z.object({ token: z.string().trim().min(1) }).strict(),
    ),
  })
  .strict();

export interface VercelProfileData {
  readonly activeVercelProfile?: string;
  readonly profiles: Readonly<Record<string, VercelProfile>>;
  readonly tokens: Readonly<Record<string, string>>;
}

interface MutableProfileData {
  activeVercelProfile?: string;
  profiles: Record<string, VercelProfile>;
  tokens: Record<string, string>;
}

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

async function loadMutableProfileData(directory: string): Promise<MutableProfileData> {
  await assertDirectoryIfPresent(directory);
  const paths = profileFilePaths(directory);
  const [rawConfig, rawCredentials] = await Promise.all([
    readPrivateJson(paths.config),
    readPrivateJson(paths.credentials),
  ]);
  const config = parseProfileDocument(paths.config, rawConfig, configSchema);
  const credentials = parseProfileDocument(paths.credentials, rawCredentials, credentialsSchema);
  return {
    ...(config?.activeVercelProfile ? { activeVercelProfile: config.activeVercelProfile } : {}),
    profiles: { ...(config?.vercelProfiles ?? {}) },
    tokens: Object.fromEntries(
      Object.entries(credentials?.vercelProfiles ?? {}).map(([name, value]) => [name, value.token]),
    ),
  };
}

function parseProfileDocument<T>(
  path: string,
  value: unknown | undefined,
  schema: z.ZodType<T>,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return schema.parse(value);
  } catch (error) {
    throw new Error(
      `SelfBench profile file has an incompatible format: ${path}. Move the file or set SELFBENCH_CONFIG_DIR to another directory.`,
      { cause: error },
    );
  }
}

async function assertDirectoryIfPresent(directory: string): Promise<void> {
  let stats: Stats;
  try {
    stats = await lstat(directory);
  } catch (error) {
    if (isFileNotFound(error)) {
      return;
    }
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      `SelfBench config path must be a directory, not a file or symlink: ${directory}`,
    );
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await assertDirectoryIfPresent(directory);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
}

async function readPrivateJson(path: string): Promise<unknown | undefined> {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`SelfBench profile path must be a regular file: ${path}`);
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`SelfBench profile file must be owner-only; run chmod 600 ${path}`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to parse SelfBench profile file ${path}`, { cause: error });
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    await rename(temporary, path);
    await chmod(path, PRIVATE_FILE_MODE);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
