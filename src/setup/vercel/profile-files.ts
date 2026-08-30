import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import { configSchema, credentialsSchema, type MutableProfileData } from "./profile-schema.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CONFIG_FILE = "config.json";
const CREDENTIALS_FILE = "credentials.json";

function profileFilePaths(directory: string) {
  return { config: join(directory, CONFIG_FILE), credentials: join(directory, CREDENTIALS_FILE) };
}

export async function loadMutableProfileData(directory: string): Promise<MutableProfileData> {
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

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await assertDirectoryIfPresent(directory);
  await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(directory, PRIVATE_DIRECTORY_MODE);
}

export async function readPrivateJson(path: string): Promise<unknown | undefined> {
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

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
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
